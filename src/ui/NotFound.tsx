import { Button } from "@carbon/react";
import { PageHeader } from "./PageHeader";

export function NotFound() {
  return (
    <>
      <PageHeader title="Not found" subtitle="This page or item does not exist (anymore)." />
      <Button size="sm" href="#/types">Back to types</Button>
    </>
  );
}
