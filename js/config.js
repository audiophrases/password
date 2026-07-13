// config.js — optional deployment-specific settings.

// CLOUD_RELAY: https URL of a deployed cloud relay Worker (README → "Cloud
// relay"). The repo ships this EMPTY on purpose: each teacher deploys their
// own free relay (install.bat → option d), so the quota and control stay
// theirs. install.bat saves the URL here for this machine; the ☁ cloud-relay
// box on the setup screen can also hold it per browser instead.
export const CLOUD_RELAY = '';
