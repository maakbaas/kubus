import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, Form, InlineNotification, Stack } from "@carbon/react";
import { useStore, useCollection } from "../app/store";
import type { FieldValue, Collection } from "../domain/model";
import { FieldInput, parseInputValue, toInputValue, type InputValue } from "../ui/FieldInput";
import { NotFound } from "../ui/NotFound";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";
import { useReferenceOptions } from "../ui/useReferenceOptions";

// The full form is only used to create an item; existing items are edited
// field by field on their view page (ItemPage).

export function NewItemPage() {
  const { collectionId } = useParams();
  const collection = useCollection(collectionId);
  if (!collection) return <NotFound />;
  return <NewItemForm key={collection.id} collection={collection} />;
}

function NewItemForm({ collection }: { collection: Collection }) {
  const { repo, collections, space } = useStore();
  const navigate = useNavigate();
  const [form, setForm] = useState<Record<string, InputValue>>(() =>
    Object.fromEntries(collection.fields.map((f) => [f.id, toInputValue(f.kind, undefined)])),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const refs = useReferenceOptions(collection);

  // Images are stored as soon as they're picked. When the form closes (saved or
  // not), release them all: anything the saved item uses is kept.
  const uploads = useRef(new Set<string>());
  useEffect(() => {
    const pending = uploads.current;
    return () => {
      if (pending.size > 0) repo.releaseFiles([...pending]).catch((e) => console.error("Releasing files failed", e));
    };
  }, [repo]);

  const listPath = `/collections/${collection.id}/items`;

  async function save(e: FormEvent) {
    e.preventDefault();
    const values: Record<string, FieldValue> = {};
    const errors: Record<string, string> = {};
    for (const f of collection.fields) {
      const parsed = parseInputValue(f.kind, form[f.id]);
      if ("error" in parsed) errors[f.id] = parsed.error;
      else values[f.id] = parsed.value;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      await repo.createItem(collection, values, space.id);
      navigate(listPath, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <div className="form-page item-view">
      <PageHeader
        title={`New ${collection.name}`}
        breadcrumbs={[
          { label: "Collections", href: "#/collections" },
          { label: collection.pluralName, href: `#${listPath}` },
        ]}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      {collection.fields.length === 0 && (
        <InlineNotification
          kind="info"
          title="This collection has no fields yet."
          subtitle="Edit the collection to add some."
          hideCloseButton
          lowContrast
        />
      )}
      <Form onSubmit={save} noValidate>
        <Stack gap={6} className="item-fields item-fields--form">
          {/* Component fields are computed, not entered. */}
          {collection.fields.filter((f) => f.kind !== "component").map((f) => (
            <FieldInput
              key={f.id}
              field={f}
              value={form[f.id]}
              error={fieldErrors[f.id]}
              options={f.targetCollectionId ? refs[f.targetCollectionId] : undefined}
              target={collections.find((t) => t.id === f.targetCollectionId)}
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
              Create {collection.name}
            </Button>
          </div>
        </Stack>
      </Form>
    </div>
  );
}
