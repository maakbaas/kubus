import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, Form, MultiSelect, Select, SelectItem, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { useItems } from "../app/useItems";
import {
  ERROR_PREFIX,
  FRAME_RATIOS,
  dollarNames,
  parseParams,
  render,
  withComputed,
  fieldLookup,
  itemsInput,
  COMPONENT_OUTPUTS,
  type BlockInputs,
  type ComponentOutput,
} from "../domain/components";
import { itemLabel, newId, now, pickableFields, type Collection, type FieldDef } from "../domain/model";
import { applyQuery, defaultQuery, isGroupable } from "../domain/query";
import { refLabelOf, useReferenceOptions } from "../ui/useReferenceOptions";
import { ComponentCodeEditor } from "../ui/ComponentCodeEditor";
import { ComponentValue } from "../ui/ComponentValue";
import { WriteWithAi } from "../ui/WriteWithAi";
import { NotFound } from "../ui/NotFound";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";

/** A test value as typed: a number when it reads as one, else text (empty = null). */
const testValue = (s: string): unknown => (s.trim() === "" ? null : !Number.isNaN(Number(s)) ? Number(s) : s);

/**
 * Creates (`/components/new`) or edits (`/components/:id`) a component: name, the component (Markdown
 * with {{ }} JavaScript sections over $variables), and a test value per variable with the rendered
 * result as you type.
 */
export function ComponentEditorPage() {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { componentId } = useParams();
  const { repo, components, collections } = useStore();
  const navigate = useNavigate();
  const existing = components.find((x) => x.id === componentId);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [code, setCode] = useState(existing?.code ?? "");
  const [output, setOutput] = useState<ComponentOutput>(existing?.output ?? "markdown");
  const [frameRatio, setFrameRatio] = useState<string | null>(existing?.frameRatio ?? null);
  /** The preview's HTML fills its box (no height of its own): then its shape can be chosen. */
  const [fills, setFills] = useState(false);
  const [tests, setTests] = useState<Record<string, string>>({});
  /** The collection (and one of its items) the preview is rendered with: what $item and $items read. */
  const [previewCollectionId, setPreviewCollectionId] = useState("");
  const [previewItemId, setPreviewItemId] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const params = useMemo(() => parseParams(code), [code]);
  // The built-ins the code uses decide which preview choices show: a collection only when it reads
  // items ($item, $items, $groups, $fields, $all), an item only for $item, and so on.
  const uses = useMemo(() => {
    const names = new Set(dollarNames(code));
    return { item: names.has("item"), groups: names.has("groups"), fields: names.has("fields"), collection: ["item", "items", "groups", "fields", "all"].some((n) => names.has(n)) };
  }, [code]);
  const previewCollection = uses.collection ? collections.find((c) => c.id === previewCollectionId) : undefined;
  const nameError = name.trim() ? undefined : "Give the component a name";

  if (componentId && !existing) return <NotFound />;

  // A test value per $variable (the preview's result follows them).
  const paramInputs = params.map((p) => (
    <TextInput
      key={p}
      size="sm"
      id={`${uid}-component-test-${p}`}
      labelText={<code>${p}</code>}
      placeholder="test value"
      className="component-code"
      value={tests[p] ?? ""}
      onChange={(e) => setTests((t) => ({ ...t, [p]: e.target.value }))}
    />
  ));

  async function save(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (nameError) return;
    setSaving(true);
    try {
      const ts = now();
      await repo.saveComponent({
        id: existing?.id ?? newId(),
        name: name.trim(),
        description: description.trim(),
        params,
        code,
        output,
        frameRatio: output === "html" ? frameRatio : null,
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
          {/* A few words in, the model writes the component and its description (it changes this form only). */}
          <WriteWithAi
            id={`${uid}-component-write`}
            current={{ name, description, output, code }}
            focus={previewCollection}
            onApply={(s) => {
              setCode(s.code);
              setDescription(s.description);
              setOutput(s.output);
              if (!name.trim()) setName(s.name);
            }}
          />
          <TextInput
            size="sm"
            id={`${uid}-component-description`}
            labelText="Description"
            placeholder="What it is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {/* A plain (monospace) text area: the Markdown editor would escape characters like * and
              break the JavaScript in {{ }}. */}
          {/* What the result is: how it shows on pages, in tables and cards (and how it sorts). */}
          <Select size="sm" id={`${uid}-component-output`} labelText="Output" value={output} onChange={(e) => setOutput(e.target.value as ComponentOutput)}>
            {COMPONENT_OUTPUTS.map((o) => (
              <SelectItem key={o.value} value={o.value} text={o.text} />
            ))}
          </Select>
          {/* Not the Markdown editor: it would escape characters like * and break the JavaScript in {{ }}. */}
          <ComponentCodeEditor
            id={`${uid}-component-code`}
            labelText="Component"
            html={output === "html"}
            placeholder={"**{{ $title }}**: {{ Math.round($pages / 40) }} h of reading"}
            helperText={`${output === "html" ? "HTML" : "Markdown"} with {{ JavaScript }} sections. Variables start with $; built in are $now (the current date) and $item, the item itself: its fields by name ($item.Pages, or $item["Read at"]) and $item.id, createdAt, updatedAt. A variable mapped to a reference gets the linked item's title.${output === "image" ? " The result is the image's URL." : ""}${output === "html" ? " It runs in a sandboxed frame: scripts work (maps, charts), the app and its data are out of reach." : ""}`}
            value={code}
            onChange={setCode}
          />
          {/* Only for HTML that fills its box (a map, a chart): content with its own height
              is shown at that height, whatever its shape. */}
          {output === "html" && fills && (
            <Select
              size="sm"
              id={`${uid}-component-frame-ratio`}
              labelText="Aspect ratio on pages"
              helperText="This HTML fills its box (like a map or a chart), so it has no height of its own. On card covers it fills the cover."
              value={frameRatio ?? "16/9"}
              onChange={(e) => setFrameRatio(e.target.value === "16/9" ? null : e.target.value)}
            >
              {FRAME_RATIOS.map((r) => (
                <SelectItem key={r} value={r} text={r.replace("/", ":")} />
              ))}
            </Select>
          )}
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
          {/* Try the formula: a value per $variable, the result right away. */}
          {previewCollection ? (
            <CollectionPreview
              key={previewCollection.id}
              collection={previewCollection}
              uses={uses}
              itemId={previewItemId}
              onItem={setPreviewItemId}
              params={params}
              code={code}
              output={output}
              tests={tests}
              frameRatio={frameRatio}
              onFill={setFills}
              inputs={paramInputs}
            />
          ) : (
            <div className="component-test">
              {paramInputs}
              <PreviewResult
                result={render({ params, code, output }, params.map((p) => testValue(tests[p] ?? "")))}
                output={output}
                frameRatio={frameRatio}
                onFill={setFills}
              />
            </div>
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
    </div>
  );
}

/** The rendered result, in the same markup as a component field on an item page, so it renders identically. */
function PreviewResult({ result, output, frameRatio, onFill }: { result: unknown; output: ComponentOutput; frameRatio: string | null; onFill(fills: boolean): void }) {
  return (
    <div className="component-test__result">
      <div className="cds--label">Result</div>
      <div className="item-fields item-fields--form component-test__preview">
        <div className="view-field">
          <div className={`view-field__value view-field__value--component${String(result ?? "").startsWith(ERROR_PREFIX) ? " view-field__value--error" : ""}`}>
            <ComponentValue value={result as never} output={output} frameRatio={frameRatio} onFill={onFill} variant="page" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The preview with a collection's items, and the choices the code calls for: an item ($item, else
 * the first), a field to group by ($groups) and the fields ($fields); $items / $all = all items.
 * Then the test values and the result.
 */
function CollectionPreview({
  collection,
  uses,
  itemId,
  onItem,
  params,
  code,
  output,
  tests,
  frameRatio,
  onFill,
  inputs,
}: {
  collection: Collection;
  uses: { item: boolean; groups: boolean; fields: boolean };
  itemId: string;
  onItem(id: string): void;
  params: string[];
  code: string;
  output: ComponentOutput;
  tests: Record<string, string>;
  frameRatio: string | null;
  onFill(fills: boolean): void;
  /** The test value inputs, shown before the result. */
  inputs: ReactNode;
}) {
  const uid = useId();
  const { components } = useStore();
  const refs = useReferenceOptions(collection);
  const { items: stored } = useItems(collection);
  const [groupBy, setGroupBy] = useState("");
  const fieldChoices = pickableFields(collection);
  const [chosenFields, setChosenFields] = useState<FieldDef[]>(fieldChoices);
  const items = useMemo(() => (stored ? withComputed(collection, stored, components, refLabelOf(refs)) : []), [stored, collection, components, refs]);
  const item = items.find((i) => i.id === itemId) ?? items[0];
  const result = useMemo(() => {
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
    return render({ params, code, output }, params.map((p) => testValue(tests[p] ?? "")), item, item && fieldLookup(collection, item, refLabel), block);
  }, [collection, items, item, refs, params, code, output, tests, groupBy, chosenFields]);
  return (
    <>
      {uses.item && (
        <Select size="sm" id={`${uid}-preview-item`} labelText={`Preview ${collection.name}`} value={item?.id ?? ""} onChange={(e) => onItem(e.target.value)} disabled={items.length === 0}>
          {items.length === 0 && <SelectItem value="" text={`No ${collection.pluralName}`} />}
          {items.map((i) => (
            <SelectItem key={i.id} value={i.id} text={itemLabel(collection, i)} />
          ))}
        </Select>
      )}
      {uses.groups && (
        <Select size="sm" id={`${uid}-preview-group`} labelText="Preview grouped by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          <SelectItem value="" text="No grouping" />
          {fieldChoices
            .filter((f) => isGroupable(f.kind))
            .map((f) => (
              <SelectItem key={f.id} value={f.id} text={f.name} />
            ))}
        </Select>
      )}
      {uses.fields && (
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
      <div className="component-test">
        {inputs}
        <PreviewResult result={result} output={output} frameRatio={frameRatio} onFill={onFill} />
      </div>
    </>
  );
}
