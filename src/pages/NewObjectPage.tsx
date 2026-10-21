import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, Form, InlineNotification, Stack } from "@carbon/react";
import { useStore, useType } from "../app/store";
import type { FieldValue, ObjectType } from "../domain/model";
import { FieldInput, parseInputValue, toInputValue, type InputValue } from "../ui/FieldInput";
import { NotFound } from "../ui/NotFound";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";
import { useReferenceOptions } from "../ui/useReferenceOptions";

// The full form is only used to create an object; existing objects are edited
// field by field on their view page (ObjectViewPage).

export function NewObjectPage() {
  const { typeId } = useParams();
  const type = useType(typeId);
  if (!type) return <NotFound />;
  return <NewObjectForm key={type.id} type={type} />;
}

function NewObjectForm({ type }: { type: ObjectType }) {
  const { repo, types } = useStore();
  const navigate = useNavigate();
  const [form, setForm] = useState<Record<string, InputValue>>(() =>
    Object.fromEntries(type.fields.map((f) => [f.id, toInputValue(f.kind, undefined)])),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const refs = useReferenceOptions(type);

  // Images are stored as soon as they're picked. When the form closes (saved or
  // not), release them all: anything the saved object uses is kept.
  const uploads = useRef(new Set<string>());
  useEffect(() => {
    const pending = uploads.current;
    return () => {
      if (pending.size > 0) repo.releaseFiles([...pending]).catch((e) => console.error("Releasing files failed", e));
    };
  }, [repo]);

  const listPath = `/types/${type.id}/objects`;

  async function save(e: FormEvent) {
    e.preventDefault();
    const values: Record<string, FieldValue> = {};
    const errors: Record<string, string> = {};
    for (const f of type.fields) {
      const parsed = parseInputValue(f.kind, form[f.id]);
      if ("error" in parsed) errors[f.id] = parsed.error;
      else values[f.id] = parsed.value;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const id = await repo.createObject(type, values);
      navigate(`${listPath}/${id}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <div className="form-page object-view">
      <PageHeader
        title={`New ${type.name}`}
        breadcrumbs={[
          { label: "Types", href: "#/types" },
          { label: type.pluralName, href: `#${listPath}` },
        ]}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      {type.fields.length === 0 && (
        <InlineNotification
          kind="info"
          title="This type has no fields yet."
          subtitle="Edit the type to add some."
          hideCloseButton
          lowContrast
        />
      )}
      <Form onSubmit={save} noValidate>
        <Stack gap={6} className="object-fields object-fields--form">
          {/* Template fields are computed, not entered. */}
          {type.fields.filter((f) => f.kind !== "template").map((f) => (
            <FieldInput
              key={f.id}
              field={f}
              value={form[f.id]}
              error={fieldErrors[f.id]}
              options={f.targetTypeId ? refs[f.targetTypeId] : undefined}
              target={types.find((t) => t.id === f.targetTypeId)}
              onChange={(v) => {
                setForm((prev) => ({ ...prev, [f.id]: v }));
                // An edit makes the field's last validation error stale; save validates again.
                setFieldErrors(({ [f.id]: _stale, ...rest }) => rest);
              }}
              onFileStored={(fileId) => uploads.current.add(fileId)}
            />
          ))}
          <div className="form-actions">
            <Button size="sm" kind="secondary" onClick={() => navigate(listPath)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={saving}>
              Create {type.name}
            </Button>
          </div>
        </Stack>
      </Form>
    </div>
  );
}
