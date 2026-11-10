import { get, run } from "./db.js";

export interface SettingsRow {
  organization_name: string;
  text_model: string;
  voice_model: string;
  voice: string;
  avatar_model: string;
  certificate_signer: string;
}

/**
 * The one settings row. It is created on first read with the column defaults:
 * the platform applies schema.sql as structure only, never data.
 */
export async function readSettings(): Promise<SettingsRow> {
  const row = await get<SettingsRow>(
    "SELECT organization_name, text_model, voice_model, voice, avatar_model, certificate_signer FROM settings WHERE id = 1",
  );
  if (row) return row;
  await run("INSERT OR IGNORE INTO settings (id) VALUES (1)");
  return (await get<SettingsRow>(
    "SELECT organization_name, text_model, voice_model, voice, avatar_model, certificate_signer FROM settings WHERE id = 1",
  ))!;
}
