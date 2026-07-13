// config.js — optional deployment-specific settings.

// CLOUD_RELAY: https URL of your deployed cloud relay Worker (README → "Cloud
// relay"), e.g. 'https://password-game.yourname.workers.dev'. Baking it in here
// makes ☁ Cloud relay work out of the box on every machine that pulls the repo;
// leaving it '' is fine too — the setup screen also accepts the URL at runtime
// (kept in that browser's localStorage).
export const CLOUD_RELAY = 'https://password-game.eugenime.workers.dev';
