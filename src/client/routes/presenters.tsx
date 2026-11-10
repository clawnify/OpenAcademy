import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, ShieldCheck, Upload } from "lucide-react";
import { TileIcon } from "@clawnify/app/client";
import { api, type Presenter, type Settings } from "../api";
import { Avatar, Badge, Button, Card, Dialog, Zone } from "../components/ui";
import { Field, Notice, Toolbar } from "../components/layout";
import { day, plural } from "../components/format";
import { TableSkeleton } from "./courses";

export function PresentersPage() {
  const [presenters, setPresenters] = useState<Presenter[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setPresenters((await api.presenters()).presenters);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { void load(); api.settings().then(setSettings, () => {}); }, [load]);

  return (
    <>
      <Toolbar icon={<TileIcon icon="video" color="pink" size={20} />} title="Presenters" actions={<Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} /> Add presenter</Button>} />
      <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A presenter is a real person, usually someone learners know, whose photo is animated to read a lesson's script in a generated voice.
          Every video made this way is shown to learners as AI generated. Use a person only with their written consent, and record it here first.
        </p>
        {settings && !settings.storage ? <Notice tone="warning">This app has no file storage, so photos and videos can't be kept. Turn on storage for the app.</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {!presenters ? (
          <TableSkeleton rows={3} />
        ) : presenters.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No presenters yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {presenters.map((p) => <PresenterCard key={p.id} p={p} settings={settings} onChanged={load} />)}
          </div>
        )}
      </div>
      <AddDialog open={adding} onOpenChange={setAdding} onDone={load} />
    </>
  );
}

function PresenterCard({ p, settings, onChanged }: { p: Presenter; settings: Settings | null; onChanged: () => Promise<void> }) {
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [consenting, setConsenting] = useState(false);
  const [editing, setEditing] = useState(false);

  async function upload(f: File) {
    setError("");
    try {
      await api.uploadPhoto(p.id, f);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card>
      <Zone className="flex items-center gap-3">
        <Avatar name={p.name} src={p.photo_url} size={56} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{p.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            Voice: {p.voice || settings?.voice || "default"} · {plural(p.lessons, "lesson")}
          </p>
        </div>
      </Zone>
      <Zone className="space-y-2">
        {p.consent ? (
          <p className="flex items-start gap-1.5 text-xs text-success">
            <ShieldCheck size={14} className="mt-px shrink-0" />
            <span>Consent recorded by {p.consent.by}, {day(p.consent.at)}{p.consent.note ? `: ${p.consent.note}` : ""}</span>
          </p>
        ) : (
          <Badge tone="warning">No consent recorded</Badge>
        )}
        <div className="flex flex-wrap gap-1.5">
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <Button variant="secondary" onClick={() => file.current?.click()}><Upload size={14} /> {p.has_photo ? "Change photo" : "Add photo"}</Button>
          <Button variant="ghost" onClick={() => setConsenting(true)}>{p.consent ? "Consent" : "Record consent"}</Button>
          <Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
        </div>
        <p className="text-xs text-muted-foreground">A front-facing photo, head and shoulders, plain background, works best.</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Zone>
      <ConsentDialog open={consenting} onOpenChange={setConsenting} p={p} onDone={onChanged} />
      <EditDialog open={editing} onOpenChange={setEditing} p={p} onDone={onChanged} />
    </Card>
  );
}

function ConsentDialog({ open, onOpenChange, p, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; p: Presenter; onDone: () => Promise<void> }) {
  const [agreed, setAgreed] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setAgreed(!!p.consent); setNote(p.consent?.note ?? ""); setError(""); } }, [open, p.consent]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${p.name}'s consent`}
      description="Record this only once the person has agreed, in writing, to training videos with an AI-generated likeness and voice of them, shown to colleagues."
      submitLabel={p.consent && !agreed ? "Withdraw consent" : "Save"}
      danger={!!p.consent && !agreed}
      submitting={!p.consent && !agreed}
      onSubmit={async () => {
        try {
          await api.updatePresenter(p.id, { consent: agreed, consent_note: note.trim() });
          onOpenChange(false);
          await onDone();
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>{p.name} has agreed to this</span>
      </label>
      <Field label="How they agreed" hint="Kept with your name and today's date.">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Signed consent form, filed with HR" />
      </Field>
      {p.consent && !agreed ? <Notice tone="warning">Videos already made stay in the lessons until you remove them.</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}

function EditDialog({ open, onOpenChange, p, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; p: Presenter; onDone: () => Promise<void> }) {
  const [name, setName] = useState(p.name);
  const [voice, setVoice] = useState(p.voice);
  const [voiceModel, setVoiceModel] = useState(p.voice_model);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { if (open) { setName(p.name); setVoice(p.voice); setVoiceModel(p.voice_model); setError(""); } }, [open, p]);
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Edit ${p.name}`}
        submitLabel="Save"
        submitting={!name.trim()}
        onSubmit={async () => {
          try {
            await api.updatePresenter(p.id, { name: name.trim(), voice: voice.trim(), voice_model: voiceModel.trim() });
            onOpenChange(false);
            await onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Voice" hint="A voice of the voice model, e.g. sarah or george. Empty: the app's default.">
          <input className="input" value={voice} onChange={(e) => setVoice(e.target.value)} />
        </Field>
        <Field label="Voice model" hint="Empty: the app's default, set in Settings.">
          <input className="input" value={voiceModel} onChange={(e) => setVoiceModel(e.target.value)} placeholder="elevenlabs/eleven-multilingual-v2" />
        </Field>
        <button type="button" className="text-sm text-destructive underline" onClick={() => { onOpenChange(false); setDeleting(true); }}>Delete presenter</button>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Dialog>
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${p.name}?`}
        description="Videos already made stay in their lessons."
        submitLabel="Delete presenter"
        danger
        onSubmit={async () => { await api.deletePresenter(p.id); setDeleting(false); await onDone(); }}
      />
    </>
  );
}

function AddDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setName(""); setError(""); } }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a presenter"
      description="Then add their photo and record their consent."
      submitLabel="Add presenter"
      submitting={!name.trim()}
      onSubmit={async () => {
        try {
          await api.addPresenter({ name: name.trim() });
          onOpenChange(false);
          await onDone();
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sam Patel, Head of Quality" autoFocus /></Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}
