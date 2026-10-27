import { Button, Modal } from "@carbon/react";
import { AiGenerate, WarningAltFilled } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useAiProgress, useAiSettings } from "../app/useAi";
import { ToolbarPopover } from "./ToolbarPopover";

/**
 * What needs the user's answer about AI values, in modals: a long queue asks for a go-ahead, and so
 * do values they typed over whose prompt has changed since (never replaced without asking).
 */
export function AiDialogs() {
  const { ai } = useStore();
  const progress = useAiProgress();
  const { fieldModel } = useAiSettings();
  return (
    <>
      {/* Many values waiting: nothing is sent until the user says so. */}
      <Modal
        open={progress.confirm > 0}
        size="xs"
        modalHeading={`Generate ${progress.confirm} AI values?`}
        primaryButtonText="Continue"
        secondaryButtonText="Not now"
        onRequestSubmit={() => ai.confirmQueue()}
        onRequestClose={() => ai.cancelQueue()}
      >
        <p>
          {progress.confirm} AI values are out of date or new, and each one is a request to {fieldModel}, at most 40 a minute. You can stop at any time with the pause switch in
          Settings → AI.
        </p>
      </Modal>
      {/* Values the user typed over, whose prompt changed since: replaced only if they say so. */}
      <Modal
        open={progress.overrides > 0 && progress.confirm === 0}
        size="xs"
        modalHeading="Replace what you typed?"
        primaryButtonText="Generate again"
        secondaryButtonText="Keep mine"
        onRequestSubmit={() => ai.replaceOverrides()}
        onRequestClose={() => ai.keepOverrides()}
      >
        <p>
          {progress.overrides === 1
            ? `${progress.overrideSample}: what its value is made from has changed since you typed it. Generate it again, replacing what you typed?`
            : `${progress.overrides} AI values you typed over (such as ${progress.overrideSample}) are made from data that has changed since. Generate them again, replacing what you typed?`}
        </p>
      </Modal>
    </>
  );
}

/**
 * The AI state left of the sync icon, shown only while there is something to tell: a model that
 * isn't set up yet, pausing, progress while many values are written, and failures (which can be
 * tried again). The icon only shows that (red on a failure); its popover tells more.
 */
export function AiStatusButton({ onSetup }: { onSetup(): void }) {
  const { ai } = useStore();
  const progress = useAiProgress();
  const unset = progress.held > 0 && !progress.configured;
  const paused = progress.paused && progress.working > 0;
  const writing = !progress.paused && progress.confirm === 0 && progress.working > 1;
  const failed = progress.failed > 0;
  if (!unset && !paused && !writing && !failed) return null;
  const label = failed ? "AI values failed" : unset ? "AI isn't set up" : paused ? "AI is paused" : "Writing AI values";
  return (
    <ToolbarPopover label={label} icon={failed ? WarningAltFilled : AiGenerate} className={failed ? "sync-status sync-status--error" : "sync-status"} fit>
      {(close) => {
        const setup = () => {
          close();
          onSetup();
        };
        return (
          <div className="sync-popover">
            {unset && (
              <>
                <p className="sync-popover__state">AI isn't set up</p>
                <p className="helper sync-popover__detail">{progress.held} AI values wait for a model.</p>
                <div>
                  <Button kind="tertiary" size="sm" onClick={setup}>
                    Open settings
                  </Button>{" "}
                  <Button kind="tertiary" size="sm" onClick={() => ai.dismissHeld()}>
                    Dismiss
                  </Button>
                </div>
              </>
            )}
            {paused && (
              <>
                <p className="sync-popover__state">AI is paused</p>
                <p className="helper sync-popover__detail">{progress.working} AI values wait. No requests are sent.</p>
                <Button kind="tertiary" size="sm" onClick={setup}>
                  Open settings
                </Button>
              </>
            )}
            {writing && (
              <>
                <p className="sync-popover__state">Writing AI values</p>
                <p className="helper sync-popover__detail">{progress.working} left</p>
              </>
            )}
            {failed && (
              <>
                <p className="sync-popover__state">{progress.failed === 1 ? "An AI value failed" : `${progress.failed} AI values failed`}</p>
                {progress.lastError && <p className="helper sync-popover__detail">{progress.lastError}</p>}
                <div>
                  <Button kind="tertiary" size="sm" onClick={() => ai.retryFailed()}>
                    Retry
                  </Button>{" "}
                  <Button kind="tertiary" size="sm" onClick={() => ai.dismissFailed()}>
                    Dismiss
                  </Button>
                </div>
              </>
            )}
          </div>
        );
      }}
    </ToolbarPopover>
  );
}
