/**
 * localStorage keys that predate the unified save (src/game/save.ts). Each
 * still holds its own runtime copy; the save file mirrors them so they can
 * follow the player to the cloud, and a first run of the save code imports
 * from them.
 */
export const AUDIO_SETTINGS_STORAGE_KEY = "energy-duel:audio-settings";
export const ONBOARDING_STORAGE_KEY = "energy-duel:onboarding-seen";
