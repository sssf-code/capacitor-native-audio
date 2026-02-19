import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'org.hiddentreasures.audiotest',
    appName: 'example',
    webDir: 'dist',
    server: {
        url: 'http://192.168.128.83:5173',
        cleartext: true,
    },
};

export default config;
