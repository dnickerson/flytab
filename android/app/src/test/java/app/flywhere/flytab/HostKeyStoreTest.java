package app.flywhere.flytab;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import java.util.Random;

/**
 * SFTP server host keys (HostKeyStore, the JSch HostKeyRepository behind
 * SftpPlugin). Keys are throwaway test keys made with ssh-keygen 2026-11-01; each
 * expected fingerprint is what `ssh-keygen -lf` printed for it.
 */
public class HostKeyStoreTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    /** {type, key A base64, fingerprint A, key B base64} per key type. */
    static final String[][] KEYS = {
        {"ssh-ed25519",
         "AAAAC3NzaC1lZDI1NTE5AAAAIKc5yJ7FD9ERw0g53bC8SmVQfAAgafjLfoCXvk6bzbeV",
         "SHA256:FhikkB/nh+PQSI1KajXI3giuhMluS3+P1T+GLMGkBjw",
         "AAAAC3NzaC1lZDI1NTE5AAAAIC/G1ZFCY/ZERllyPIrQJ9h+v+O6CgUFaaMPMcuz8MDE"},
        {"ecdsa-sha2-nistp256",
         "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHRgytYsPQkEyy2JedaGKMpx1n+EG9RNTkVKkGXvXIoZGv3G0036u+dvNb0nL+B3ZF+HFt44Bj3mzm9qxciFCUU=",
         "SHA256:q4z2B25lYaYLrdmbJC9l5aHiPJPyrGTbb3z0jn9pAeI",
         "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEl4ug5CBFatD6Ta8QsEiw3VfJy9PEDk9KehZxHQTBvyeXiMO4uhmcizfGk0ksjruKLELbQWrkrpaIuptF8TBIQ="},
        {"ecdsa-sha2-nistp384",
         "AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBEijH/MoSG69FV0mMO8Uxar93QqXRIuxmru5W2s3r5X9/0JJ5wHiVM5kvPXnMj3qe5nBL2EVJ7uyk88lqeYgUxjqFWYYpNbHLP1YqhJSdoeajmGqNH41Ru8p4d7m6VG+Sg==",
         "SHA256:ni3y7wyqMCSRLEqV8e1syRtNHisQaTuD7nJk0pMCQPc",
         "AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBFv6yaA27B1Arg2LuIe+kV9B253xa+AzFC3J5s7hcDDKsJ/g1tEhkd8omsEKthhrLklcxdpp2qgSehyYrcf0vle9sH0N2hQPdPNxmbTmTzx3JrPjqoGdwIN9exwCXQ9QDg=="},
        {"ecdsa-sha2-nistp521",
         "AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAHl3351z78oKQ1c1IbFK0qD/K8rflihuUXmiJmSEmg4MGuvIdm681/I8CzF8XY3Q/h6oFP1omwG+umsh95nCSmpFQBS1JUId9plel1chhnfbZugZzsfHzYK7Ti74L9A0l9Mza6OhZQudDzrqurcuDAMN7WyhIe15ucTVQy21KttZEGiTQ==",
         "SHA256:VLzS0NbnHRTamG2+0ByIh0oaOpRijjQhMgx1N36RW+I",
         "AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAEWrOupQeUahhN/G3vqTpbhBo4GuK/hh1DfGpKbX3LirxPgM1XPBSPPRFLF6gaDdRCaWht9sxxCZxrvtFiLL4na+gBTMkqgvQBCHoogAmkMbJhQ4dauSEOPBDsgur2BdAxGlbzOmki6zfESiHQgAeVrNasHjDRWS0Joji5Lx6gqwWqFCg=="},
        {"ssh-rsa",
         "AAAAB3NzaC1yc2EAAAADAQABAAABAQDT3HSotVlAy4IUlAWk8mnkghrVhxPDvrCAkojeTVpelGt5ivLCSdYPjG83e9k1hL0v3VJiklhv8TOKa6bnCfxhY7UhQxONggSgd8omvrpP4CvkgCG5fCDGdLSffIwIHJv9u+LU7uSZtDEXSGAORLtoUznCpLq0/D6pBFp+CtJCLUoCoG/8apyPx/rVpaDEwnOPKBRkB3hSpKMoBhUxrjENVYdGe/irY2tX4ru+Mc0/AjoqhHkmdCud8AYSWI+YH2ACMFOza5DKV5uA4xL9P5IHbaLhEfR45bzC/KsRVU0o62I0f6S/qtps0+FtDNad83iLHKA81stZ8DgTEgxNyrij",
         "SHA256:TkZx0L4C2WcLVShvOJBu51eB8bnEvurJ91zhx3QaykE",
         "AAAAB3NzaC1yc2EAAAADAQABAAABAQCqDqFHXk0n6yRkFDHUCZbLEBruG51c4hnx8LdM1Sl+JvI8Q6+nREn+mEJhitopD+muxExXLBza+waanVzxJCESPBJZVLud96eWrCkymYuqP4nys1IALFA3aq/oJ6LP40kfnuINa5+fzMRN+RneSmn1aI7oJHApJorIzj/X1S89svmKVUeT5vL+aqwhGDuO7AgoBM1nKjvjRpcW7T65uoNAngkFenvnFaGQY3BoRj1jsIhKinhoTRI5glM8M4JtjtyOlDkecQkuGaWLOmq9Wppuz+n4ykMP+D0VsnIDmQkDJiERHQKB+xpOVSm5mROsUULCPJteQVg9I82HAjgWqGel"},
    };

    private static byte[] b(String b64) { return Base64.getDecoder().decode(b64); }

    private File kh() { return new File(tmp.getRoot(), "sftp_known_hosts"); }

    private HostKeyStore trusted(String host, int port, String[] k) throws Exception {
        HostKeyStore s = new HostKeyStore(kh());
        s.trust(host, port, k[0], k[1], k[2]);
        return new HostKeyStore(kh());            // reloaded from disk
    }

    @Test
    public void fingerprintsAndTypesMatchSshKeygen() {
        for (String[] k : KEYS) {
            assertEquals(k[0], k[2], HostKeyStore.fingerprintSha256(b(k[1])));
            assertEquals(k[0], HostKeyStore.keyTypeOf(b(k[1])));
        }
        assertEquals("ed25519", HostKeyStore.shortType("ssh-ed25519"));
        assertEquals("ecdsa", HostKeyStore.shortType("ecdsa-sha2-nistp384"));
        assertEquals("rsa", HostKeyStore.shortType("ssh-rsa"));
    }

    @Test
    public void okNotIncludedChangedForEachKeyType() throws Exception {
        for (String[] k : KEYS) {
            File f = kh();
            f.delete();
            HostKeyStore s = trusted("nas.local", 2222, k);
            String id = "[nas.local]:2222";
            assertEquals(k[0], HostKeyRepository.OK, s.check(id, b(k[1])));
            assertNull(k[0], s.failedVerdict());
            assertEquals(k[0], HostKeyRepository.CHANGED, s.check(id, b(k[3])));
            HostKeyStore.Verdict v = s.failedVerdict();
            assertEquals(k[0], v.keyType);
            assertEquals(HostKeyStore.fingerprintSha256(b(k[3])), v.fingerprint);
            assertEquals(1, v.knownFingerprints.size());
            assertTrue(v.knownFingerprints.get(0).startsWith(k[2]));
            assertEquals(k[0], HostKeyRepository.NOT_INCLUDED, s.check("[other.local]:2222", b(k[1])));
            assertArrayEquals(b(k[1]), s.failedVerdict().key);
            assertEquals(k[1], s.failedVerdict().keyBase64);
        }
    }

    @Test
    public void aDifferentKeyTypeForAKnownHostIsChanged() throws Exception {
        HostKeyStore s = trusted("nas.local", 22, KEYS[4]);                 // rsa on record
        for (int i = 0; i < 4; i++) {                                         // ed25519 / ecdsa presented
            assertEquals(KEYS[i][0], HostKeyRepository.CHANGED, s.check("nas.local", b(KEYS[i][1])));
        }
    }

    @Test
    public void noFallbackBetweenHostAndHostPort() throws Exception {
        HostKeyStore s = trusted("nas.local", 22, KEYS[0]);
        assertEquals(HostKeyRepository.OK, s.check("nas.local", b(KEYS[0][1])));
        assertEquals(HostKeyRepository.NOT_INCLUDED, s.check("[nas.local]:2222", b(KEYS[0][1])));
        kh().delete();
        HostKeyStore s2 = trusted("nas.local", 2222, KEYS[0]);
        assertEquals(HostKeyRepository.NOT_INCLUDED, s2.check("nas.local", b(KEYS[0][1])));
        assertEquals("host ids compare case-insensitively", HostKeyRepository.OK, s2.check("[NAS.local]:2222", b(KEYS[0][1])));
    }

    @Test
    public void trustRefusals() throws Exception {
        HostKeyStore s = new HostKeyStore(kh());
        String[] k = KEYS[0];
        expectIae(() -> s.trust("nas.local", 22, k[0], k[1], KEYS[1][2]));     // wrong fingerprint
        expectIae(() -> s.trust("nas.local", 22, "ssh-rsa", k[1], k[2]));      // wrong type
        expectIae(() -> s.trust("bad host", 22, k[0], k[1], k[2]));
        expectIae(() -> s.trust("evil\nhost", 22, k[0], k[1], k[2]));
        expectIae(() -> s.trust("nas,local", 22, k[0], k[1], k[2]));
        expectIae(() -> s.trust("nas.local", 0, k[0], k[1], k[2]));
        expectIae(() -> s.trust("nas.local", 65536, k[0], k[1], k[2]));
        expectIae(() -> s.trust("nas.local", 22, k[0], k[1] + "!", k[2]));     // not base64
        expectIae(() -> s.trust("nas.local", 22, k[0], "AAAA", "SHA256:x"));    // too short
        assertFalse("nothing written", kh().exists());

        s.trust("nas.local", 22, k[0], k[1], k[2]);
        s.trust("nas.local", 22, k[0], k[1], k[2]);                              // same key again: no-op
        try {
            s.trust("nas.local", 22, KEYS[1][0], KEYS[1][1], KEYS[1][2]);       // overwrite with another
            fail("trusted over an existing different key");
        } catch (IllegalStateException expected) { }
        assertEquals(1, new HostKeyStore(kh()).fingerprintsFor("nas.local", 22).size());
    }

    @Test
    public void forgetRemovesOnlyThatHostPort() throws Exception {
        HostKeyStore s = new HostKeyStore(kh());
        s.trust("nas.local", 22, KEYS[0][0], KEYS[0][1], KEYS[0][2]);
        s.trust("nas.local", 2222, KEYS[1][0], KEYS[1][1], KEYS[1][2]);
        assertEquals(1, s.forget("nas.local", 22));
        HostKeyStore r = new HostKeyStore(kh());
        assertTrue(r.fingerprintsFor("nas.local", 22).isEmpty());
        assertEquals(1, r.fingerprintsFor("nas.local", 2222).size());
        assertEquals(0, r.forget("nas.local", 22));
        assertEquals(1, HostKeyStore.forgetOrReset(kh(), "nas.local", 2222));
        assertTrue(new HostKeyStore(kh()).fingerprintsFor("nas.local", 2222).isEmpty());
        assertFalse("no temp file left", new File(kh().getPath() + ".tmp").exists());
    }

    @Test
    public void strictBase64() {
        Random r = new Random(7);
        for (int i = 0; i < 1000; i++) {
            byte[] d = new byte[1 + r.nextInt(80)];
            r.nextBytes(d);
            String enc = HostKeyStore.base64Encode(d);
            assertEquals(Base64.getEncoder().encodeToString(d), enc);
            assertArrayEquals(d, HostKeyStore.base64Decode(enc));
        }
        for (String bad : new String[]{null, "", "A", "AB=C", "A===", "=ABC", "AB C", "AB*=", "ABC", "AAAA\n"}) {
            assertNull(String.valueOf(bad), HostKeyStore.base64Decode(bad));
        }
    }

    @Test
    public void loadSkipsBlankLinesAndComments() throws Exception {
        String[] k = KEYS[0];
        Files.write(kh().toPath(), ("# FlyTab\n\n[nas.local]:2222 " + k[0] + " " + k[1] + "\n").getBytes(StandardCharsets.UTF_8));
        assertEquals(HostKeyRepository.OK, new HostKeyStore(kh()).check("[nas.local]:2222", b(k[1])));
    }

    @Test
    public void aLineThatDoesNotParseFailsClosed() throws Exception {
        String[] k = KEYS[0];
        String good = "nas.local " + k[0] + " " + k[1] + "\n";
        String[] bad = {
            "nas.local " + k[0] + "\n",                                    // missing key
            "nas.local ssh-rsa " + k[1] + "\n",                            // type does not match the key
            "nas.local " + k[0] + " " + k[1] + "!!\n",                     // not base64
            "@revoked nas.local " + k[0] + " " + k[1] + "\n",              // markers are not ours
            "|1|abc=|def= " + k[0] + " " + k[1] + "\n",                    // hashed hosts are not ours
            "[nas.local]:99999 " + k[0] + " " + k[1] + "\n",               // bad port
            "nas.local " + k[0] + " " + k[1] + " extra\n",
        };
        for (String line : bad) {
            Files.write(kh().toPath(), (good + line).getBytes(StandardCharsets.UTF_8));
            try {
                new HostKeyStore(kh());
                fail("loaded a damaged store: " + line);
            } catch (HostKeyStore.DamagedException e) {
                assertTrue(e.getMessage(), e.getMessage().startsWith(HostKeyStore.DamagedException.MESSAGE));
            }
        }
        // Forget resets a damaged store (Configuration -> Forget server key), then it works again
        assertEquals(-1, HostKeyStore.forgetOrReset(kh(), "nas.local", 22));
        assertFalse(kh().exists());
        HostKeyStore s = new HostKeyStore(kh());
        assertEquals(HostKeyRepository.NOT_INCLUDED, s.check("nas.local", b(k[1])));
    }

    @Test
    public void jschNeverAddsAndSeesNoRevokedMarker() throws Exception {
        HostKeyStore s = trusted("nas.local", 22, KEYS[0]);
        s.add(new HostKey("other.local", b(KEYS[1][1])), null);
        assertTrue(new HostKeyStore(kh()).fingerprintsFor("other.local", 22).isEmpty());
        HostKey[] keys = s.getHostKey("nas.local", null);
        assertEquals(1, keys.length);
        assertEquals("", keys[0].getMarker());
        assertEquals("ssh-ed25519", keys[0].getType());
        assertEquals(0, s.getHostKey("nas.local", "ssh-rsa").length);
    }

    @Test
    public void applyToMakesTheSessionStrict() throws Exception {
        HostKeyStore s = new HostKeyStore(kh());
        Session session = new JSch().getSession("u", "nas.local", 22);
        session.setConfig("StrictHostKeyChecking", "no");
        s.applyTo(session);
        assertEquals("yes", session.getConfig("StrictHostKeyChecking"));
        assertTrue(session.getHostKeyRepository() == s);
    }

    private interface Body { void run() throws Exception; }

    private static void expectIae(Body b) throws Exception {
        try {
            b.run();
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) { }
    }
}
