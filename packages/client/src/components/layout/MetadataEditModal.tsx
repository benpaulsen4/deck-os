import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { trpcClient, useTRPC } from "../../trpc";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useToastStore } from "../../stores/toast";
import type { App } from "../../../../server/src/lib/schema.js";

interface MetadataEditModalProps {
  app: App;
  isOpen: boolean;
  onClose: () => void;
}

function checkMetadataModified(
  app: App,
  name: string,
  description: string,
  icon: string,
  url: string
): boolean {
  return (
    name !== app.metadata.name ||
    description !== (app.metadata.description || "") ||
    icon !== (app.metadata.icon || "") ||
    url !== (app.metadata.url || "")
  );
}

export function MetadataEditModal({ app, isOpen, onClose }: MetadataEditModalProps) {
  const { addToast } = useToastStore();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [editedName, setEditedName] = useState("");
  const [editedDescription, setEditedDescription] = useState("");
  const [editedIcon, setEditedIcon] = useState("");
  const [editedUrl, setEditedUrl] = useState("");
  const [metadataModified, setMetadataModified] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setEditedName(app.metadata.name);
      setEditedDescription(app.metadata.description || "");
      setEditedIcon(app.metadata.icon || "");
      setEditedUrl(app.metadata.url || "");
      setMetadataModified(false);
    }
  }, [isOpen, app]);

  const updateMetadataMutation = useMutation({
    mutationFn: async () =>
      await trpcClient.apps.update.mutate({
        id: app.id,
        name: editedName.trim(),
        description: editedDescription,
        icon: editedIcon.trim(),
        url: editedUrl.trim(),
      }),
    onSuccess: async () => {
      addToast("Metadata updated", "success");
      setMetadataModified(false);
      onClose();
      await queryClient.invalidateQueries({
        queryKey: trpc.apps.list.queryOptions().queryKey,
      });
      await queryClient.invalidateQueries({
        queryKey: trpc.apps.get.queryOptions({ id: app.id }).queryKey,
      });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addToast(`Failed to update metadata: ${message}`, "error");
    },
  });

  const handleClose = () => {
    setEditedName(app.metadata.name);
    setEditedDescription(app.metadata.description || "");
    setEditedIcon(app.metadata.icon || "");
    setEditedUrl(app.metadata.url || "");
    setMetadataModified(false);
    onClose();
  };

  const handleFieldChange = (
    field: "name" | "description" | "icon" | "url",
    value: string
  ) => {
    switch (field) {
      case "name":
        setEditedName(value);
        break;
      case "description":
        setEditedDescription(value);
        break;
      case "icon":
        setEditedIcon(value);
        break;
      case "url":
        setEditedUrl(value);
        break;
    }
    setMetadataModified(
      checkMetadataModified(
        app,
        field === "name" ? value : editedName,
        field === "description" ? value : editedDescription,
        field === "icon" ? value : editedIcon,
        field === "url" ? value : editedUrl
      )
    );
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-backdrop" onClick={handleClose} />
      <div
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="metadata-edit-modal-title"
      >
        <h2 id="metadata-edit-modal-title" className="modal-title">
          EDIT METADATA
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <Input
            label="APP NAME"
            value={editedName}
            onChange={(e) => handleFieldChange("name", e.target.value)}
            required
          />
          <Input
            label="DESCRIPTION"
            value={editedDescription}
            onChange={(e) => handleFieldChange("description", e.target.value)}
            placeholder="My awesome app"
          />
          <Input
            label="ICON URL"
            value={editedIcon}
            onChange={(e) => handleFieldChange("icon", e.target.value)}
            placeholder="https://example.com/icon.png"
          />
          <Input
            label="WEB URL"
            value={editedUrl}
            onChange={(e) => handleFieldChange("url", e.target.value)}
            placeholder="http://localhost:8080"
          />
        </div>

        <div className="modal-actions">
          <Button variant="secondary" onClick={handleClose}>
            CANCEL
          </Button>
          <Button
            variant="primary"
            onClick={() => updateMetadataMutation.mutate()}
            disabled={
              updateMetadataMutation.isPending || !editedName.trim() || !metadataModified
            }
          >
            {updateMetadataMutation.isPending ? "SAVING..." : "SAVE"}
          </Button>
        </div>
      </div>
    </div>
  );
}
