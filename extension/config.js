// Default relay server. scripts/make-safari-app.sh overwrites this file in the
// build copy when EDC_SERVER is set, so both devices share the same default.
self.EDC_CONFIG = {
  server: 'http://localhost:8787',
};
