import { useEffect, useId, useState } from "react";
import {
  Button,
  CodeSnippet,
  Form,
  FormGroup,
  IconButton,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextInput,
} from "@carbon/react";
import { TrashCan } from "@carbon/icons-react";
import type { ApiTokenAccess, ApiTokenInfo, ApiTokenMade } from "../../../shared/tokens";
import { useStore } from "../app/store";
import { FillTable } from "../views/TableView";
import { RowActions, ROW_BUTTON } from "./RowActions";
import { errorMessage, useConfirm } from "./useConfirm";
import { useMountedDialog } from "./useMountedDialog";

// The connected server's API tokens (shared/tokens.ts), for other tools: each reaches only the HTTP
// API, to read or to read and write. Made, listed and revoked here with this device's token; a
// made token is shown once (MadeToken), the server keeps only its hash.

const ACCESS_TEXT: Record<ApiTokenAccess, string> = { read: "Read", write: "Read & write" };

export function ApiTokens() {
  const uid = useId();
  const { sources, repo } = useStore();
  const { url, token } = repo.sync.config;
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ApiTokenAccess>("read");
  const [submitted, setSubmitted] = useState(false);
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<ApiTokenMade | null>(null);
  const { confirm, dialog } = useConfirm();
  const nameError = !name.trim() ? "Give the token a name" : undefined;

  useEffect(() => {
    setTokens(null);
    setError(undefined);
    sources.apiTokens().then(setTokens, (e) => setError(errorMessage(e)));
  }, [sources, url, token]);

  const make = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setSubmitted(true);
    if (nameError) return;
    setMaking(true);
    setError(undefined);
    try {
      const next = await sources.makeApiToken({ name: name.trim(), access });
      setTokens((list) => [...(list ?? []), next]);
      setMade(next);
      setName("");
      setSubmitted(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMaking(false);
    }
  };

  const revoke = async (t: ApiTokenInfo) => {
    const ok = await confirm({
      title: `Revoke ${t.name}?`,
      body: "Whatever uses this token can't reach the server any more. This can't be undone.",
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    try {
      await sources.revokeApiToken(t.id);
      setTokens((list) => list && list.filter((x) => x.id !== t.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <FormGroup legendText="API tokens">
      <Stack gap={6}>
        <p className="helper">
          For scripts and other tools: a token reaches only the server's API (Help → API), to read or to read and write. Your devices'
          token can do everything; give a tool its own token instead, and revoke it when it is no longer used.
        </p>
        {error && <InlineNotification kind="error" title="API tokens" subtitle={error} lowContrast hideCloseButton />}
        {tokens && tokens.length > 0 && (
          <FillTable>
            <Table size="sm">
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader>
                  <TableHeader>Access</TableHeader>
                  <TableHeader>Made</TableHeader>
                  <TableHeader>Last used</TableHeader>
                  <TableHeader aria-label="Actions" />
                </TableRow>
              </TableHead>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{t.name}</TableCell>
                    <TableCell>{ACCESS_TEXT[t.access]}</TableCell>
                    <TableCell>{new Date(t.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "Never"}</TableCell>
                    <RowActions>
                      <IconButton {...ROW_BUTTON} label={`Revoke ${t.name}`} onClick={() => void revoke(t)}>
                        <TrashCan />
                      </IconButton>
                    </RowActions>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FillTable>
        )}
        {tokens?.length === 0 && <p className="helper">No API tokens yet.</p>}
        <Form onSubmit={make} noValidate>
          <Stack gap={6}>
            <TextInput
              size="sm"
              id={`${uid}-name`}
              labelText="Name"
              placeholder="e.g. Backup script"
              helperText="What uses it, to know it again in this list."
              value={name}
              invalid={submitted && !!nameError}
              invalidText={nameError}
              onChange={(e) => setName(e.target.value)}
            />
            <Select size="sm" id={`${uid}-access`} labelText="Access" value={access} onChange={(e) => setAccess(e.target.value === "write" ? "write" : "read")}>
              <SelectItem value="read" text={ACCESS_TEXT.read} />
              <SelectItem value="write" text={ACCESS_TEXT.write} />
            </Select>
            <div>
              <Button size="sm" kind="tertiary" type="submit" disabled={making || tokens === null}>
                Make a token
              </Button>
            </div>
          </Stack>
        </Form>
      </Stack>
      {made && <MadeToken made={made} onClose={() => setMade(null)} />}
      {dialog}
    </FormGroup>
  );
}

/** A token just made: shown this once, with a copy button. */
function MadeToken({ made, onClose }: { made: ApiTokenMade; onClose(): void }) {
  const open = useMountedDialog();
  return (
    <Modal
      open={open}
      size="xs"
      modalHeading={`API token ${made.name}`}
      primaryButtonText="Done"
      // A stray click mustn't lose it.
      preventCloseOnClickOutside
      onRequestSubmit={onClose}
      onRequestClose={onClose}
    >
      <Stack gap={5}>
        <p>
          Copy it now: it is shown only this once. {made.access === "read" ? "It can only read." : "It can read and write."} Send it as a bearer
          token (Authorization: Bearer …).
        </p>
        <CodeSnippet type="multi" wrapText autoAlign feedback="Copied" copyButtonDescription="Copy the token">
          {made.token}
        </CodeSnippet>
      </Stack>
    </Modal>
  );
}
