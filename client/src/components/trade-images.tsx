import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Camera, Loader2, Trash2, X } from "lucide-react";
import {
  archiveDataUrl,
  fileToDownscaledDataUrl,
  useAddTradeImage,
  useDeleteTradeImage,
  useTradeImages,
} from "@/lib/data";

/**
 * The visual record of a trade: screenshots kept for review, not parsing.
 *
 * Images live in their own table and arrive only when this gallery mounts —
 * the trade list never carries them. Attach by drop, file pick, or Ctrl+V
 * while the detail dialog is open; none of it calls a model, because the
 * point here is memory, not extraction.
 */

const KIND_LABELS: Record<string, string> = {
  setup: "Setup",
  outcome: "Outcome",
  other: "",
};

export function TradeImageGallery({ tradeId }: { tradeId: number }) {
  const { data: images = [], isLoading } = useTradeImages(tradeId);
  const add = useAddTradeImage();
  const del = useDeleteTradeImage();
  const { toast } = useToast();
  const [lightbox, setLightbox] = useState<number | null>(null);

  async function attach(file: File) {
    try {
      // Archival quality, not parse quality — this copy is kept forever.
      const data = await archiveDataUrl(await fileToDownscaledDataUrl(file));
      await add.mutateAsync({ tradeId, kind: "other", data });
    } catch (err: any) {
      toast({
        title: "Couldn't attach that image",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    }
  }

  // Ctrl+V while the dialog is open attaches to this trade. Image items only;
  // pasted text keeps going wherever the caret is.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const f = items[i].getAsFile();
          if (f) {
            e.preventDefault();
            attach(f);
          }
          return;
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeId]);

  const shown = lightbox != null ? images.find((i) => i.id === lightbox) : null;

  return (
    <div>
      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        Screenshots
      </p>

      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {images.map((img) => (
            <div key={img.id} className="group relative">
              <button
                type="button"
                onClick={() => setLightbox(img.id)}
                className="block w-full overflow-hidden rounded-md border border-border/70 bg-black/30"
                data-testid={`thumb-image-${img.id}`}
              >
                <img
                  src={img.data}
                  alt={KIND_LABELS[img.kind] || "Trade screenshot"}
                  className="aspect-video w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                />
              </button>
              {KIND_LABELS[img.kind] && (
                <span className="absolute left-1 top-1 rounded bg-background/80 px-1 py-0.5 text-[9px] text-muted-foreground">
                  {KIND_LABELS[img.kind]}
                </span>
              )}
              <button
                type="button"
                onClick={() => del.mutate({ id: img.id, tradeId })}
                aria-label="Delete screenshot"
                className="absolute right-1 top-1 hidden rounded bg-background/80 p-1 text-muted-foreground hover:text-destructive group-hover:block"
                data-testid={`button-delete-image-${img.id}`}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}

          {/* Attach tile: drop, click, or Ctrl+V anywhere in the dialog. */}
          <label
            className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f?.type.startsWith("image/")) attach(f);
            }}
            data-testid="label-attach-image"
          >
            {add.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Camera className="h-4 w-4" />
            )}
            <span className="px-1 text-center text-[9px] leading-tight">
              drop · click · Ctrl+V
            </span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) attach(f);
              }}
            />
          </label>
        </div>
      )}

      {/* Lightbox: the reason to keep screenshots at all is looking at them. */}
      {shown && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-background/90 p-6 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
          data-testid="lightbox"
        >
          <img
            src={shown.data}
            alt="Trade screenshot"
            className="max-h-full max-w-full rounded-lg border border-border shadow-2xl"
          />
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
