import { useId, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, Form, Select, SelectItem, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { ERROR_PREFIX, FRAME_RATIOS, parseParams, render, COMPONENT_OUTPUTS, type ComponentOutput } from "../domain/components";
import { newId, now } from "../domain/model";
import { ComponentCodeEditor } from "../ui/ComponentCodeEditor";
import { ComponentValue } from "../ui/ComponentValue";
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
  const { repo, components } = useStore();
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
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const params = useMemo(() => parseParams(code), [code]);
  const result = useMemo(
    () => render({ params, code, output }, params.map((p) => testValue(tests[p] ?? ""))),
    [params, code, output, tests],
  );
  const nameError = name.trim() ? undefined : "Give the component a name";

  if (componentId && !existing) return <NotFound />;

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
          {/* Try the formula: a value per $variable, the result right away. */}
          <div className="component-test">
            {params.map((p) => (
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
            ))}
            <div className="component-test__result">
              <div className="cds--label">Result</div>
              {/* The same markup as a component field on an item page, so it renders identically. */}
              <div className="item-fields item-fields--form component-test__preview">
                <div className="view-field">
                  <div className={`view-field__value view-field__value--component${String(result ?? "").startsWith(ERROR_PREFIX) ? " view-field__value--error" : ""}`}>
                    <ComponentValue value={result} output={output} frameRatio={frameRatio} onFill={setFills} variant="page" />
                  </div>
                </div>
              </div>
            </div>
          </div>
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
