global.configuration = {
    DEBUG: false,
    showOfflineUsers: true, // When true all users will always be shown. Offline users will be shown as away on clients that support away-notify.
    discordToken: '<TOKEN>',
    tlsEnabled: true,
    tlsOptions: {
      keyPath: '/path/to/key.pem',
      certPath: '/path/to/cert.pem'
    },
    discord: {
      messageLimit: 20
    },
    handleCode: true, 
    githubToken: '<TOKEN>',
    ircServer: {
        listenPort: 6667,
        hostname: '<HOSTNAME>',
        username: '<USERNAME>' 
    }
};
