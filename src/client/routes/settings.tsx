import { useEffect, useState } from "react";
import { TileIcon } from "@clawnify/app/client";
import { api, type Settings } from "../api";
import { Button, Card, CardTitle, Picker, Zone } from "../components/ui";
import { Field, Notice, Toolbar } from "../components/layout";

type Models = { text: { id: string; name: string }[]; speech: { id: string; name: string }[]; video: { id: string; name: string }[] };

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [models, setModels] = useState<Models | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then(setS, (e: Error) => setError(e.message));
    Promise.all([api.models("text"), api.models("speech"), api.models("video")]).then(
      ([text, speech, video]) => setModels({ text: text.models, speech: speech.models, video: video.models }),
      (e: Error) => setModelsError(e.message),
    );
  }, []);

  if (!s) return error ? <div className="p-6"><Notice tone="danger">{error}</Notice></div> : null;
  const set = (k: keyof Settings) => (v: string) => { setS({ ...s, [k]: v }); setSaved(""); };
  const options = (list: { id: string; name: string }[] | undefined, current: string, auto?: string) => {
    const out = [...(auto ? [{ value: "", label: auto }] : []), ...(list ?? []).map((m) => ({ value: m.id, label: m.name }))];
    if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: current });
    return out;
  };

  async function save() {
    setError("");
    try {
      const { storage: _s, ai: _a, ...rest } = s!;
      await api.saveSettings(rest);
      setSaved("Saved");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Toolbar icon={<TileIcon icon="settings" size={20} />} title="Settings" />
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        <Card>
          <Zone><CardTitle>What learners see</CardTitle></Zone>
          <Zone className="space-y-3">
            <Field label="Organisation name" hint="At the top of every course and certificate.">
              <input className="input" value={s.organization_name} onChange={(e) => set("organization_name")(e.target.value)} placeholder="Northwind Logistics" />
            </Field>
            <Field label="Certificates issued by" hint="A person or role, printed on certificates.">
              <input className="input" value={s.certificate_signer} onChange={(e) => set("certificate_signer")(e.target.value)} placeholder="Dana Quality, QHSE Manager" />
            </Field>
          </Zone>
        </Card>
        <Card>
          <Zone><CardTitle>AI models</CardTitle></Zone>
          <Zone className="space-y-3">
            {!s.ai ? <Notice tone="warning">No AI key is set for this app, so drafting and presenter videos are off.</Notice> : null}
            {modelsError ? <Notice tone="warning">{modelsError}</Notice> : null}
            <Field label="Drafting courses">
              <Picker label="Drafting model" value={s.text_model} onChange={set("text_model")} options={options(models?.text, s.text_model, "Automatic")} />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Voice model">
                <Picker label="Voice model" value={s.voice_model} onChange={set("voice_model")} options={options(models?.speech, s.voice_model)} />
              </Field>
              <Field label="Default voice" hint="A voice that model offers, e.g. sarah.">
                <input className="input" value={s.voice} onChange={(e) => set("voice")(e.target.value)} />
              </Field>
            </div>
            <Field label="Presenter video model" hint="Animates a photo to the voice track.">
              <Picker label="Presenter video model" value={s.avatar_model} onChange={set("avatar_model")} options={options(models?.video, s.avatar_model)} />
            </Field>
            <p className="text-xs text-muted-foreground">
              The presenter's photo and voice track are sent to the video model's provider to make each video. Check that provider's data
              terms before you use a real person.
            </p>
          </Zone>
          <Zone className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{saved}</span>
            <Button variant="secondary" className="ml-auto" onClick={save}>Save settings</Button>
          </Zone>
          {error ? <Zone><Notice tone="danger">{error}</Notice></Zone> : null}
        </Card>
      </div>
    </>
  );
}
