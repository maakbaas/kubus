import { useId, useMemo, useState } from "react";
import { InlineNotification, Modal, Select, SelectItem, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { newId, now } from "../domain/model";
import { parseParams, COMPONENT_OUTPUTS, type Component, type ComponentOutput } from "../domain/components";
import { ComponentCodeEditor } from "./ComponentCodeEditor";
import { errorMessage } from "./useConfirm";

/**
 * Creates a component without leaving the field modal it is chosen in: name, output and code
 * (the full editor with its test values lives at `#/components`).
 */
export function NewComponentModal({ onClose, onCreated }: { onClose(): void; onCreated(component: Component): void }) {
  const uid = useId();
  const { repo, components } = useStore();
  const [name, setName] = useState("");
  const [output, setOutput] = useState<ComponentOutput>("markdown");
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const params = useMemo(() => parseParams(code), [code]);
  const taken = components.some((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
  const nameError = !name.trim() ? "Give the component a name" : taken ? "Another component has this name" : undefined;

  async function save() {
    setSubmitted(true);
    if (nameError) return;
    setSaving(true);
    const ts = now();
    const component: Component = { id: newId(), name: name.trim(), params, code, output, frameRatio: null, createdAt: ts, updatedAt: ts };
    try {
      await repo.saveComponent(component);
      onCreated(component);
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
      modalHeading="New component"
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
        <Select size="sm" id={`${uid}-output`} labelText="Output" value={output} onChange={(e) => setOutput(e.target.value as ComponentOutput)}>
          {COMPONENT_OUTPUTS.map((o) => (
            <SelectItem key={o.value} value={o.value} text={o.text} />
          ))}
        </Select>
        <ComponentCodeEditor
          id={`${uid}-code`}
          labelText="Component"
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
