import { useId, useMemo, useState, type FormEvent } from "react";
import { useRemoteResult } from "../views/useRemoteResult";
import { useNavigate, useParams } from "react-router";
import { Button, Form, InlineNotification, MultiSelect, Select, SelectItem, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { useAiSettings } from "../app/useAi";
import { useItems } from "../app/useItems";
import { parseAiReply, promptRequest } from "../domain/ai";
import {
  ERROR_PREFIX,
  codeProblem,
  dollarNames,
  isAiOutput,
  placeProblem,
  render,
  withComputed,
  fieldLookup,
  itemsInput,
  type BlockInputs,
  type ComponentOutput,
} from "../domain/components";
import { itemLabel, newId, now, pickableFields, type Collection, type FieldDef } from "../domain/model";
import { applyQuery, defaultQuery, isGroupable } from "../domain/query";
import { refLabelOf, useReferenceOptions } from "../ui/useReferenceOptions";
import { ComponentForm } from "../ui/ComponentForm";
import { ComponentValue } from "../ui/ComponentValue";
import { NotFound } from "../ui/NotFound";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { useItemCounts } from "../app/useItemCounts";

/**
 * Creates (`/components/new`) or edits (`/components/:id`) a shared component: name, the component
 * (Markdown with {{ }} JavaScript sections over the built-in $ names), whether it asks AI, and the
 * rendered result as you type (with a collection's items, when the code reads them). A component
 * that asks AI previews the prompt as it reads for an item, and "Try" asks the model once.
 */
export function ComponentEditorPage() {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { componentId } = useParams();
  const { repo, components, collections } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const counts = useItemCounts();
  const existing = components.find((x) => x.id === componentId);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [code, setCode] = useState(existing?.code ?? "");
  const [output, setOutput] = useState<ComponentOutput>(existing?.output ?? "markdown");
  const [frameRatio, setFrameRatio] = useState<string | null>(existing?.frameRatio ?? null);
  const [ai, setAi] = useState(existing?.ai ?? false);
  /** The collection (and one of its items) the preview is rendered with: what $item and $items read. */
  const [previewCollectionId, setPreviewCollectionId] = useState("");
  const [previewItemId, setPreviewItemId] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  // The fields using it: they fix whether it asks AI (computed or stored values), and an AI
  // field's output (its stored values' form).
  const users = useMemo(
    () => (existing ? collections.flatMap((c) => c.fields.filter((f) => f.code === null && f.componentId === existing.id)) : []),
    [collections, existing],
  );
  const aiLocked = users.length > 0;
  const outputLocked = users.some((f) => f.kind === "ai");

  // The built-ins the code uses decide which preview choices show: a collection only when it reads
  // items ($item, $items, $groups, $fields, $all), an item only for $item, and so on.
  const uses = useMemo(() => {
    const names = new Set(dollarNames(code));
    return { item: names.has("item"), groups: names.has("groups"), fields: names.has("fields"), collection: ["item", "items", "groups", "fields", "all"].some((n) => names.has(n)) };
  }, [code]);
  const previewCollection = uses.collection ? collections.find((c) => c.id === previewCollectionId) : undefined;
  const nameError = name.trim() ? undefined : "Give the component a name";
  // Unknown $ names, or one item ($item) and a block's items together: such code fits no place,
  // so it isn't saved; a prompt also mustn't read $now or a block's items.
  const codeError = useMemo(() => (ai ? placeProblem({ code, ai }, "field") : codeProblem(code)) ?? undefined, [code, ai]);

  if (componentId && !existing) return <NotFound />;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (nameError || codeError) return;
    // A changed prompt makes every value of the AI fields using it stale: they are all asked again.
    const aiUsers = users.filter((f) => f.kind === "ai");
    if (existing && aiUsers.length > 0 && existing.code !== code) {
      const n = aiUsers.reduce((sum, f) => sum + (counts[f.collectionId] ?? 0), 0);
      const ok = await confirm({
        title: "Change the prompt everywhere?",
        body: `${aiUsers.length === 1 ? "An AI field uses" : `${aiUsers.length} AI fields use`} it (${aiUsers.map((f) => `“${f.name}”`).join(", ")}): their values are made again by the language model, for up to ${n === 1 ? "1 item" : `${n} items`}.`,
        confirmLabel: "Change prompt",
        danger: false,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const ts = now();
      await repo.saveComponent({
        id: existing?.id ?? newId(),
        name: name.trim(),
        description: description.trim(),
        code,
        output,
        frameRatio: output === "html" ? frameRatio : null,
        ai,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      });
      navigate("/components");
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="form-page">
      <PageHeader
        current={existing ? existing.name : "New component"}
        title={existing ? existing.name : "New component"}
        breadcrumbs={[{ label: "Components", href: "#/components" }]}
      />
      <Form onSubmit={save} noValidate>
        <Stack gap={6}>
          <TextInput
            size="sm"
            id={`${uid}-component-name`}
            labelText="Name"
            placeholder="e.g. Reading time"
            value={name}
            onChange={(e) => setName(e.target.value)}
            invalid={submitted && !!nameError}
            invalidText={nameError}
          />
          <TextInput
            size="sm"
            id={`${uid}-component-description`}
            labelText="Description"
            placeholder="What it is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {/* The same editor as where a component is written in place (ComponentForm). The Value switch is
              fixed while fields use it; an AI component's output while AI fields do. Write with AI
              also fills in the description (and the name, while empty). */}
          <ComponentForm
            id={`${uid}-component`}
            value={{ code, output, frameRatio, ai }}
            onChange={(next) => {
              setCode(next.code);
              setOutput(next.output);
              setFrameRatio(next.frameRatio);
              setAi(next.ai);
            }}
            askAi={{ locked: aiLocked }}
            outputLocked={outputLocked}
            outputHelp={outputLocked ? "Fixed while AI fields use it: their values are stored in this form." : aiLocked ? "Whether it asks AI is fixed while fields use it." : undefined}
            invalidText={codeError}
            writer={{
              focus: previewCollection,
              name,
              description,
              onNamed: (suggested, described) => {
                setDescription(described);
                if (!name.trim()) setName(suggested);
              },
            }}
          />
          {/* The collection whose items $item and $items read in the preview (none: they are empty). */}
          {uses.collection && (
            <Select
              size="sm"
              id={`${uid}-component-preview-collection`}
              labelText="Preview with collection"
              helperText="Renders the result with its items: one of them as $item, all of them as $items."
              value={previewCollectionId}
              onChange={(e) => {
                setPreviewCollectionId(e.target.value);
                setPreviewItemId("");
              }}
            >
              <SelectItem value="" text="None" />
              {collections.map((c) => (
                <SelectItem key={c.id} value={c.id} text={c.name} />
              ))}
            </Select>
          )}
          {/* Try it: the result right away. */}
          {previewCollection ? (
            <CollectionPreview
              key={previewCollection.id}
              collection={previewCollection}
              uses={uses}
              itemId={previewItemId}
              onItem={setPreviewItemId}
              code={code}
              output={output}
              ai={ai}
              name={name}
              frameRatio={frameRatio}
            />
          ) : ai ? (
            <p className="helper">Choose a collection to preview the prompt for one of its items.</p>
          ) : (
            <PreviewResult result={render({ code, output })} output={output} frameRatio={frameRatio} />
          )}
          {error && <p className="cds--form-requirement">{error}</p>}
          <div className="form-actions">
            <Button size="sm" kind="secondary" onClick={() => navigate("/components")}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={saving}>
              {existing ? "Save changes" : "Create component"}
            </Button>
          </div>
        </Stack>
      </Form>
      {dialog}
    </div>
  );
}

/** The rendered result, in the same markup as a component field on an item page, so it renders identically. */
function PreviewResult({ result, output, frameRatio, label = "Result" }: { result: unknown; output: ComponentOutput; frameRatio: string | null; label?: string }) {
  return (
    <div className="component-test__result">
      <div className="cds--label">{label}</div>
      <div className="item-fields item-fields--form component-test__preview">
        <div className="view-field">
          <div className={`view-field__value view-field__value--component${String(result ?? "").startsWith(ERROR_PREFIX) ? " view-field__value--error" : ""}`}>
            <ComponentValue value={result as never} output={output} frameRatio={frameRatio} variant="page" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The preview with a collection's items, and the choices the code calls for: an item ($item, else
 * the first), a field to group by ($groups) and the fields ($fields); $items / $all = all items.
 * Then the result; for a component that asks AI, the prompt as it reads for the item, and "Try".
 */
function CollectionPreview({
  collection,
  uses,
  itemId,
  onItem,
  code,
  output,
  ai,
  name,
  frameRatio,
}: {
  collection: Collection;
  uses: { item: boolean; groups: boolean; fields: boolean };
  itemId: string;
  onItem(id: string): void;
  code: string;
  output: ComponentOutput;
  ai: boolean;
  /** The component's name: what the model is told the field is called, in "Try". */
  name: string;
  frameRatio: string | null;
}) {
  const uid = useId();
  const { components } = useStore();
  const refs = useReferenceOptions(collection);
  const { items: stored } = useItems(collection);
  // A remote collection's rows: its first page, asked of its source (computed fields worked out).
  const firstPage = useMemo(defaultQuery, []);
  const remote = useRemoteResult(collection, firstPage, "", true);
  const [groupBy, setGroupBy] = useState("");
  const fieldChoices = pickableFields(collection);
  const [chosenFields, setChosenFields] = useState<FieldDef[]>(fieldChoices);
  const remoteItems = remote ? remote.items : undefined;
  const items = useMemo(
    () => (remoteItems !== undefined ? (remoteItems ?? []) : stored ? withComputed(collection, stored, components, refLabelOf(refs)) : []),
    [remoteItems, stored, collection, components, refs],
  );
  const item = items.find((i) => i.id === itemId) ?? items[0];
  const result = useMemo(() => {
    if (ai) return null;
    const refLabel = refLabelOf(refs);
    const input = itemsInput(collection, refLabel);
    const all = items.map(input);
    const grouped = groupBy ? applyQuery(collection, items, { ...defaultQuery(), groupBy }, { refLabel }).groups : null;
    const block: BlockInputs = {
      items: all,
      groups: grouped ? grouped.map((g) => ({ key: g.key, label: g.label, items: g.items.map(input) })) : [{ key: "", label: "All", items: all }],
      fields: chosenFields.map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
      all,
    };
    return render({ code, output }, item, item && fieldLookup(collection, item, refLabel), block);
  }, [ai, collection, items, item, refs, code, output, groupBy, chosenFields]);
  // A prompt as it reads for the item (what would be sent), or why none would be.
  const request = useMemo(
    () => (ai && item ? promptRequest(collection, name.trim() || "Value", { code, output, frameRatio: null, ai: true }, isAiOutput(output) ? output : "string", item, refLabelOf(refs)) : null),
    [ai, item, collection, name, code, output, refs],
  );
  return (
    <>
      {remote?.error && <InlineNotification kind="error" lowContrast hideCloseButton title={collection.pluralName} subtitle={remote.error} />}
      {uses.item && (
        <Select size="sm" id={`${uid}-preview-item`} labelText={`Preview ${collection.name}`} value={item?.id ?? ""} onChange={(e) => onItem(e.target.value)} disabled={items.length === 0}>
          {items.length === 0 && <SelectItem value="" text={`No ${collection.pluralName}`} />}
          {items.map((i) => (
            <SelectItem key={i.id} value={i.id} text={itemLabel(collection, i)} />
          ))}
        </Select>
      )}
      {!ai && uses.groups && (
        <Select size="sm" id={`${uid}-preview-group`} labelText="Preview grouped by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          <SelectItem value="" text="No grouping" />
          {fieldChoices
            .filter((f) => isGroupable(f.kind))
            .map((f) => (
              <SelectItem key={f.id} value={f.id} text={f.name} />
            ))}
        </Select>
      )}
      {!ai && uses.fields && (
        <MultiSelect<FieldDef>
          autoAlign
          size="sm"
          id={`${uid}-preview-fields`}
          titleText="Preview with fields"
          label={`${chosenFields.length} of ${fieldChoices.length} fields`}
          items={fieldChoices}
          itemToString={(f) => f?.name ?? ""}
          selectedItems={chosenFields}
          onChange={({ selectedItems }) => setChosenFields(fieldChoices.filter((f) => selectedItems?.some((s) => s.id === f.id)))}
        />
      )}
      {ai ? (
        request && <PromptPreview request={request} output={isAiOutput(output) ? output : "string"} />
      ) : (
        <PreviewResult result={result} output={output} frameRatio={frameRatio} />
      )}
    </>
  );
}

/** A prompt as it reads for the preview's item ("Sent to the model"), and "Try": the model's reply, once (nothing is stored). */
function PromptPreview({ request, output }: { request: ReturnType<typeof promptRequest>; output: "string" | "number" | "markdown" }) {
  const { ai } = useStore();
  const { paused } = useAiSettings(); // re-renders when the settings change
  const configured = ai.isConfigured("field") && !paused;
  const [reply, setReply] = useState<{ value: unknown } | { error: string } | null>(null);
  const [asking, setAsking] = useState(false);
  if ("problem" in request) return <PreviewResult result={ERROR_PREFIX + request.problem} output="string" frameRatio={null} label="Sent to the model" />;
  const tryIt = async () => {
    setAsking(true);
    setReply(null);
    try {
      const text = await ai.client("field").complete([
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ]);
      const parsed = parseAiReply(output, text);
      setReply("error" in parsed ? parsed : { value: parsed.value });
    } catch (e) {
      setReply({ error: errorMessage(e) });
    } finally {
      setAsking(false);
    }
  };
  return (
    <>
      <PreviewResult result={request.prompt} output="string" frameRatio={null} label="Sent to the model" />
      <div>
        <Button size="sm" kind="tertiary" disabled={!configured || asking} onClick={tryIt}>
          {asking ? "Asking…" : "Try"}
        </Button>
      </div>
      {!configured && <p className="helper">Set up a language model in Settings to try the prompt.</p>}
      {reply && "error" in reply && <InlineNotification kind="error" lowContrast hideCloseButton title="The model's reply doesn't fit" subtitle={reply.error} />}
      {reply && "value" in reply && <PreviewResult result={reply.value} output={output} frameRatio={null} label="The model's reply (not stored)" />}
    </>
  );
}
