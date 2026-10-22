import { useId, useMemo, useState } from "react";
import { InlineNotification, Modal, Select, SelectItem, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { newId, now } from "../domain/model";
import { parseParams, TEMPLATE_OUTPUTS, type Template, type TemplateOutput } from "../domain/templates";
import { TemplateCodeEditor } from "./TemplateCodeEditor";
import { errorMessage } from "./useConfirm";

/**
 * Creates a template without leaving the field modal it is chosen in: name, output and code
 * (the full editor with its test values lives at `#/templates`).
 */
export function NewTemplateModal({ onClose, onCreated }: { onClose(): void; onCreated(template: Template): void }) {
  const uid = useId();
  const { repo, templates } = useStore();
  const [name, setName] = useState("");
  const [output, setOutput] = useState<TemplateOutput>("markdown");
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const params = useMemo(() => parseParams(code), [code]);
  const taken = templates.some((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
  const nameError = !name.trim() ? "Give the template a name" : taken ? "Another template has this name" : undefined;

  async function save() {
    setSubmitted(true);
    if (nameError) return;
    setSaving(true);
    const ts = now();
    const template: Template = { id: newId(), name: name.trim(), params, code, output, frameRatio: null, createdAt: ts, updatedAt: ts };
    try {
      await repo.saveTemplate(template);
      onCreated(template);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      size="sm"
      className="modal--menus"
      modalHeading="New template"
      primaryButtonText="Create"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestClose={onClose}
      onRequestSubmit={save}
    >
      <Stack gap={5}>
        {error && <InlineNotification kind="error" title="Could not save" subtitle={error} lowContrast hideCloseButton />}
        <TextInput
          size="sm"
          id={`${uid}-name`}
          labelText="Name"
          placeholder="e.g. Reading time"
          value={name}
          onChange={(e) => setName(e.target.value)}
          invalid={submitted && !!nameError}
          invalidText={nameError}
        />
        <Select size="sm" id={`${uid}-output`} labelText="Output" value={output} onChange={(e) => setOutput(e.target.value as TemplateOutput)}>
          {TEMPLATE_OUTPUTS.map((o) => (
            <SelectItem key={o.value} value={o.value} text={o.text} />
          ))}
        </Select>
        <TemplateCodeEditor
          id={`${uid}-code`}
          labelText="Template"
          html={output === "html"}
          placeholder={"**{{ $title }}**: {{ Math.round($pages / 40) }} h of reading"}
          helperText="Markdown or HTML with {{ JavaScript }} sections. Variables start with $; map them to fields afterwards."
          value={code}
          onChange={setCode}
        />
      </Stack>
    </Modal>
  );
}
