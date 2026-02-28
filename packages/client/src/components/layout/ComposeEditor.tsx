import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { trpcClient } from "../../trpc";
import { Button } from "../ui/Button";
import { CodeEditor } from "../ui/CodeEditor";
import { useToastStore } from "../../stores/toast";
import type { App } from "../../../../server/src/lib/schema.js";

interface ComposeEditorProps {
  app: App;
}

export function ComposeEditor({ app }: ComposeEditorProps) {
  const { addToast } = useToastStore();
  const [isOpen, setIsOpen] = useState(false);
  const [editedComposeYaml, setEditedComposeYaml] = useState("");
  const [composeModified, setComposeModified] = useState(false);

  useEffect(() => {
    setEditedComposeYaml(app.composeYaml);
    setComposeModified(false);
  }, [app]);

  const updateComposeMutation = useMutation({
    mutationFn: async () =>
      await trpcClient.apps.updateCompose.mutate({
        id: app.id,
        composeYaml: editedComposeYaml,
      }),
    onSuccess: () => {
      addToast("Compose file updated", "success");
      setComposeModified(false);
      setIsOpen(false);
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addToast(`Failed to update compose: ${message}`, "error");
    },
  });

  const handleCancel = () => {
    setEditedComposeYaml(app.composeYaml);
    setComposeModified(false);
  };

  return (
    <div className="app-detail-section compose-section">
      <div className="app-detail-section-header">
        <div className="app-detail-section-label">COMPOSE FILE</div>
        <Button variant="secondary" onClick={() => setIsOpen(!isOpen)}>
          {isOpen ? "CLOSE" : "EDIT"}
        </Button>
      </div>
      {isOpen ? (
        <div className="panel compose-editor-panel">
          <div className="compose-editor-body">
            <CodeEditor
              value={editedComposeYaml}
              onChange={(value) => {
                setEditedComposeYaml(value);
                setComposeModified(value !== app.composeYaml);
              }}
              minHeight="320px"
            />
          </div>
          {composeModified && (
            <div className="modal-actions">
              <Button variant="secondary" onClick={handleCancel}>
                CANCEL
              </Button>
              <Button
                variant="primary"
                onClick={() => updateComposeMutation.mutate()}
                disabled={updateComposeMutation.isPending}
              >
                {updateComposeMutation.isPending ? "SAVING..." : "SAVE"}
              </Button>
            </div>
          )}
          {composeModified && (
            <div className="app-detail-modifier-note">
              Stack restart required to apply changes
            </div>
          )}
        </div>
      ) : (
        <div className="panel compose-editor-panel">
          <div className="compose-editor-body">
            <pre className="app-detail-compose-pre">{app.composeYaml}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
