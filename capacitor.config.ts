import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.flywhere.flytab',
  appName: 'FlyTab',
  webDir: 'web',
  server: {
    androidScheme: 'https',
    cleartext: true,  // Allow HTTP to localhost NanoHTTPD tile server
  },
  plugins: {
    CapacitorHttp: {
      enabled: false,  // Use native fetch for Stratux/engine connections
    },
    StatusBar: {
      overlaysWebView: false,
      backgroundColor: '#1a1a1a',
      style: 'DARK',
    },
  },
  android: {
    allowMixedContent: true,  // Allow HTTP tile server from HTTPS WebView
  },
};

export default config;
