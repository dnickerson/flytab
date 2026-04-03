import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.flywhere.flytab',
  appName: 'FlyTab',
  webDir: 'web',
  server: {
    androidScheme: 'http',  // Use http://localhost — avoids mixed content blocking HTTP to home server/NanoHTTPD
    cleartext: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: false,  // Use native fetch for Stratux/engine connections
    },
    StatusBar: {
      overlaysWebView: false,
      backgroundColor: '#000000',
      style: 'LIGHT',
    },
  },
  android: {
    allowMixedContent: true,  // Allow HTTP tile server from HTTPS WebView
  },
};

export default config;
