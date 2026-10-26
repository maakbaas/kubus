import { ActionableNotification, Button, InlineNotification, Modal } from "@carbon/react";
import { useStore } from "../app/store";
import { useAiProgress, useAiSettings } from "../app/useAi";

/**
 * What needs the user about AI values: a long queue asks for a go-ahead in a modal, and so do values
 * they typed over whose prompt has changed since (they are never replaced without asking); along the
 * bottom of the window, a model that isn't set up yet, pausing, progress while many values are
 * written, and failures (which can be tried again).
 */
export function AiBanner({ onSetup }: { onSetup(): void }) {
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
      {/* Their actions are tertiary buttons in the text (Carbon's own action button of an inline
          notification is a ghost one, and text buttons are never borderless here). */}
      {(progress.held > 0 || progress.failed > 0 || progress.paused || progress.working > 1) && (
        <div className="ai-banner">
          {progress.held > 0 && !progress.configured && (
            <ActionableNotification
              inline
              lowContrast
              kind="info"
              title="AI isn't set up"
              subtitle={`${progress.held} AI values wait for a model.`}
              onCloseButtonClick={() => {
                ai.dismissHeld();
                return false;
              }}
            >
              <Button kind="tertiary" size="sm" className="ai-banner__action" onClick={onSetup}>
                Open settings
              </Button>
            </ActionableNotification>
          )}
          {progress.paused && progress.working > 0 && (
            <ActionableNotification
              inline
              lowContrast
              hideCloseButton
              kind="info"
              title="AI is paused"
              subtitle={`${progress.working} AI values wait. No requests are sent.`}
            >
              <Button kind="tertiary" size="sm" className="ai-banner__action" onClick={onSetup}>
                Open settings
              </Button>
            </ActionableNotification>
          )}
          {!progress.paused && progress.confirm === 0 && progress.working > 1 && (
            <InlineNotification lowContrast hideCloseButton kind="info" title="Writing AI values" subtitle={`${progress.working} left`} />
          )}
          {progress.failed > 0 && (
            <ActionableNotification
              inline
              lowContrast
              kind="error"
              title={progress.failed === 1 ? "An AI value failed" : `${progress.failed} AI values failed`}
              subtitle={progress.lastError}
              onCloseButtonClick={() => {
                ai.dismissFailed();
                return false;
              }}
            >
              <Button kind="tertiary" size="sm" className="ai-banner__action" onClick={() => ai.retryFailed()}>
                Retry
              </Button>
            </ActionableNotification>
          )}
        </div>
      )}
    </>
  );
}
