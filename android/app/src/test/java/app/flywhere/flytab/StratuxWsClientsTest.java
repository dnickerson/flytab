package app.flywhere.flytab;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * OkHttp behavior the Stratux link depends on, exercised against a fake server
 * that behaves like Stratux's /situation handler (main/managementinterface.go
 * handleSituationWS): completes the WebSocket handshake, then only WRITES a
 * frame every 100 ms and never reads — so it never answers a ping or a close.
 *
 * - An OkHttp WebSocket is a running dispatcher call for its whole life (its
 *   read loop runs inside the call's callback). OkHttp exempts WebSocket calls
 *   from the 5-per-host limit (Dispatcher.enqueue only shares the per-host
 *   counter for non-WebSocket calls) — pinned by moreThanFive… below.
 * - A graceful close() keeps the call (thread, TCP connection, Stratux still
 *   writing 10 Hz into it) until the server acknowledges the close or OkHttp's
 *   60 s cancel timer fires; this server, like Stratux /situation, never does.
 */
public class StratuxWsClientsTest {

    private ServerSocket server;
    private final List<Socket> accepted = new ArrayList<>();
    private volatile boolean running = true;

    @Before
    public void startFakeStratux() throws Exception {
        server = new ServerSocket(0);
        Thread t = new Thread(() -> {
            while (running) {
                try {
                    Socket s = server.accept();
                    synchronized (accepted) { accepted.add(s); }
                    new Thread(() -> serveWriteOnly(s)).start();
                } catch (Exception e) { return; }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    @After
    public void stopFakeStratux() throws Exception {
        running = false;
        server.close();
        synchronized (accepted) { for (Socket s : accepted) try { s.close(); } catch (Exception ignored) {} }
    }

    private void serveWriteOnly(Socket s) {
        try {
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
            String key = null, line;
            while ((line = in.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("sec-websocket-key:")) key = line.substring(18).trim();
            }
            String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.ISO_8859_1)));
            OutputStream out = s.getOutputStream();
            out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            byte[] payload = "{\"GPSFixQuality\":2}".getBytes(StandardCharsets.UTF_8);
            while (running) {                      // write-only, like handleSituationWS
                out.write(0x81);                   // FIN + text
                out.write(payload.length);         // unmasked, < 126
                out.write(payload);
                out.flush();
                Thread.sleep(100);
            }
        } catch (Exception ignored) { }
    }

    private String url() { return "ws://127.0.0.1:" + server.getLocalPort() + "/situation"; }

    private WebSocket open(OkHttpClient client, CountDownLatch opened) {
        return client.newWebSocket(new Request.Builder().url(url()).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response r) { opened.countDown(); }
        });
    }

    private static void awaitRunning(OkHttpClient c, int expected, long timeoutMs) throws InterruptedException {
        long end = System.currentTimeMillis() + timeoutMs;
        while (c.dispatcher().runningCallsCount() != expected && System.currentTimeMillis() < end) Thread.sleep(20);
    }

    @Test
    public void situationChannelHasNoPingsOtherChannelsDo() {
        StratuxWsClients clients = new StratuxWsClients();
        assertEquals(0, clients.forChannel(false).pingIntervalMillis());
        assertEquals(30_000, clients.forChannel(true).pingIntervalMillis());
    }

    @Test
    public void moreThanFiveConcurrentSocketsToStratuxAllOpen() throws Exception {
        StratuxWsClients clients = new StratuxWsClients();
        CountDownLatch opened = new CountDownLatch(8);
        List<WebSocket> ws = new ArrayList<>();
        for (int i = 0; i < 8; i++) ws.add(open(clients.forChannel(false), opened));
        assertTrue("8 concurrent sockets must all open (WebSockets are exempt from the per-host limit)",
            opened.await(5, TimeUnit.SECONDS));
        for (WebSocket w : ws) StratuxWsClients.release(w);
    }

    @Test
    public void releaseFreesTheSlotImmediatelyEvenWhenServerNeverAcksClose() throws Exception {
        StratuxWsClients clients = new StratuxWsClients();
        OkHttpClient c = clients.forChannel(false);
        CountDownLatch opened = new CountDownLatch(1);
        WebSocket w = open(c, opened);
        assertTrue(opened.await(5, TimeUnit.SECONDS));
        assertEquals(1, c.dispatcher().runningCallsCount());

        StratuxWsClients.release(w);
        awaitRunning(c, 0, 2000);
        assertEquals("released socket must not linger (graceful close keeps it 60 s)",
            0, c.dispatcher().runningCallsCount());
    }

    @Test
    public void releaseOfANotYetStartedSocketFreesIt() throws Exception {
        StratuxWsClients clients = new StratuxWsClients();
        OkHttpClient c = clients.forChannel(false);
        WebSocket w = open(c, new CountDownLatch(1));
        StratuxWsClients.release(w);
        awaitRunning(c, 0, 2000);
        assertEquals(0, c.dispatcher().runningCallsCount());
        assertEquals(0, c.dispatcher().queuedCallsCount());
    }
}
