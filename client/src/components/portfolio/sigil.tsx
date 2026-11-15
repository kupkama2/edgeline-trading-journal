import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ExternalLink, Loader2, Pencil, RefreshCw, Sparkles, Upload } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { fmtAmount } from "@shared/metrics";
import { changeCount, ecoOf, isQuiet, isUnverified, pragueDay, segmentOf, sigilGroups, sigilMovers, sigilReport, sigilStreaks, type SigilAsset, type SigilChange, type SigilPosition } from "@shared/sigil";
import { useEnrichSigilAsset, useSaveSigilAsset, useSigil, useSigilSeed, useSigilUpload, type SigilState } from "@/lib/sigil";
import { Donut, ValueLine } from "./charts";

/** A percent with its sign; a move too small to show at this precision is a plain zero, not "−0.0%". */
const pct = (n: number | null | undefined, d = 1) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const body = Math.abs(n).toFixed(d);
  return Number(body) === 0 ? `${body}%` : `${n > 0 ? "+" : "−"}${body}%`;
};
const tone = (n: number | null | undefined) => (n == null || Math.abs(n) < 0.05 ? "text-muted-foreground" : n > 0 ? "text-emerald-400" : "text-red-400");
const qty = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : Math.abs(n) >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumSignificantDigits: 4 }));
const price = (n: number | null) => (n == null ? "—" : n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumSignificantDigits: 4 }));
const said = (err: any) => String(err?.message ?? err).replace(/^\d{3}:\s*/, "").replace(/^\{"message":"(.*)"\}$/, "$1");
const dayGap = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000);

/** A day's record as lines: the same report an upload answers with. */
function ReportLines({ lines }: { lines: string[] }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed" data-testid="sigil-report">
      {lines.map((l, i) => (
        <span key={i} className={i === 0 ? "font-semibold text-foreground" : /^(ADDED)/.test(l) ? "text-emerald-400" : /^(REMOVED)/.test(l) ? "text-red-400" : /^(RESIZED)/.test(l) ? "text-amber-400" : "text-muted-foreground"}>
          {l}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function ChangeCard({ change, previousValue, recent }: { change: SigilChange; previousValue: number | null; recent: boolean }) {
  // A quiet day is folded, and so is anything older than the last few updates: the page is for what is happening now.
  const quiet = !recent || (isQuiet(change) && !change.notes?.length);
  const lines = sigilReport(change, { previousValueUsd: previousValue });
  const body = (
    <>
      <ReportLines lines={lines.slice(1)} />
      {change.notes?.map((n, i) => (
        <p key={i} className="mt-1 text-[11px] text-muted-foreground">
          Note: {n}
        </p>
      ))}
      {change.aiRead && (
        <p className="mt-1.5 rounded border border-border/60 bg-secondary/40 px-2 py-1 text-[11px]" data-testid="sigil-ai-read">
          <span className="font-semibold">AI reading, not a fact: </span>
          {change.aiRead}
        </p>
      )}
    </>
  );
  const n = changeCount(change);
  return (
    <details open={!quiet} className="rounded-md border border-border/70 bg-card px-3 py-2" data-testid={`sigil-change-${change.date}`}>
      <summary className="flex cursor-pointer items-center gap-2 text-xs">
        <span className="font-mono font-semibold">{change.date}</span>
        <span className={n ? "text-foreground" : "text-muted-foreground"}>{change.status === "baseline" ? "first snapshot" : n ? `${n} change${n === 1 ? "" : "s"}` : change.dust.length ? "dust only" : "quiet day"}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{fmtAmount(change.portfolioValueUsd, 0)}</span>
      </summary>
      <div className="mt-1.5">{body}</div>
    </details>
  );
}

function AssetEditor({ symbol, name, asset, lists, onClose }: { symbol: string; name: string; asset: SigilAsset | undefined; lists: SigilState["lists"]; onClose: () => void }) {
  const save = useSaveSigilAsset();
  const { toast } = useToast();
  const [v, setV] = useState({ segment: asset?.segment ?? "", eco: asset?.eco ?? "", link: asset?.link ?? "", tldr: asset?.tldr ?? "", note: asset?.note ?? "" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const onSave = async () => {
    try {
      await save.mutateAsync({ symbol, patch: { segment: v.segment || null, eco: v.eco.trim() || null, link: v.link.trim() || null, tldr: v.tldr.trim() || null, note: v.note.trim() || null } });
      onClose();
    } catch (err) {
      toast({ title: "Not saved", description: said(err), variant: "destructive" });
    }
  };
  const field = "h-9 w-full rounded-md border border-input bg-background px-2 text-xs";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto" data-testid="sigil-asset-editor">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {name} <span className="font-mono text-muted-foreground">{symbol}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-xs">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Segment</span>
            <select className={field} value={v.segment} onChange={set("segment")} data-testid="sigil-edit-segment">
              <option value="">Uncategorized</option>
              {lists.segments.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Ecosystem</span>
            <Input className="h-9 text-xs" list="sigil-ecos" value={v.eco} onChange={set("eco")} data-testid="sigil-edit-eco" />
            <datalist id="sigil-ecos">
              {lists.ecos.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Chart link</span>
            <Input className="h-9 text-xs" placeholder="https://…" value={v.link} onChange={set("link")} />
          </label>
          <label className="block">
            <span className="mb-1 block text-muted-foreground">What it is</span>
            <Textarea className="min-h-16 text-xs" value={v.tldr} onChange={set("tldr")} />
          </label>
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Your note</span>
            <Textarea className="min-h-12 text-xs" value={v.note} onChange={set("note")} placeholder="An open question, a correction" />
          </label>
          {asset?.flagged && <p className="text-amber-500">Flagged when it was last read: {asset.flagged}.</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={save.isPending} data-testid="sigil-edit-save">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type SortKey = "name" | "amount" | "priceUsd" | "totalUsd" | "roi24h" | "share";

function Holdings({ positions, assets, lists, enrich, segment, eco, setSegment, setEco }: { positions: SigilPosition[]; assets: Record<string, SigilAsset>; lists: SigilState["lists"]; enrich: SigilState["enrich"]; segment: string | null; eco: string | null; setSegment: (s: string | null) => void; setEco: (s: string | null) => void }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "totalUsd", dir: -1 });
  const [editing, setEditing] = useState<SigilPosition | null>(null);
  const reEnrich = useEnrichSigilAsset();
  const { toast } = useToast();
  const segments = useMemo(() => Array.from(new Set(positions.map((p) => segmentOf(assets[p.symbol])))).sort(), [positions, assets]);
  const ecos = useMemo(() => Array.from(new Set(positions.map((p) => ecoOf(assets[p.symbol])))).sort(), [positions, assets]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return positions
      .filter((p) => (!segment || segmentOf(assets[p.symbol]) === segment) && (!eco || ecoOf(assets[p.symbol]) === eco))
      .filter((p) => !needle || `${p.name} ${p.symbol} ${assets[p.symbol]?.tldr ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const av = sort.key === "name" ? a.name.toLowerCase() : (a[sort.key] ?? -Infinity);
        const bv = sort.key === "name" ? b.name.toLowerCase() : (b[sort.key] ?? -Infinity);
        return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
      });
  }, [positions, assets, q, sort, segment, eco]);
  const th = (key: SortKey, label: string, cls = "") => (
    <th className={`cursor-pointer select-none whitespace-nowrap px-1.5 py-1.5 font-medium ${cls}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1 }))} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      {label}
      {sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
    </th>
  );
  const select = "h-8 max-w-[45vw] rounded-md border border-input bg-background px-2 text-xs";
  const onEnrich = async (symbol: string) => {
    try {
      await reEnrich.mutateAsync(symbol);
      toast({ title: `Reading ${symbol} again`, description: "It updates here when the answer lands." });
    } catch (err) {
      toast({ title: "Not started", description: said(err), variant: "destructive" });
    }
  };
  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="sigil-holdings">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Holdings <span className="font-normal normal-case tracking-normal">· {rows.length} of {positions.length}</span>
        </p>
        <Input className="ml-auto h-8 w-36 text-xs sm:w-48" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} data-testid="sigil-search" />
        <select className={select} value={segment ?? ""} onChange={(e) => setSegment(e.target.value || null)} aria-label="Segment" data-testid="sigil-filter-segment">
          <option value="">All segments</option>
          {segments.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select className={select} value={eco ?? ""} onChange={(e) => setEco(e.target.value || null)} aria-label="Ecosystem" data-testid="sigil-filter-eco">
          <option value="">All ecosystems</option>
          {ecos.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="sigil-table">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              {th("name", "Asset")}
              {th("amount", "Amount", "hidden text-right md:table-cell")}
              {th("priceUsd", "Price", "hidden text-right sm:table-cell")}
              {th("totalUsd", "Value", "text-right")}
              {th("roi24h", "24h", "text-right")}
              {th("share", "Share", "text-right")}
              <th className="hidden px-1.5 py-1.5 font-medium lg:table-cell">Segment</th>
              <th className="hidden px-1.5 py-1.5 font-medium lg:table-cell">Eco</th>
              <th className="hidden px-1.5 py-1.5 font-medium xl:table-cell">What it is</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const a = assets[p.symbol];
              const busy = enrich.running.includes(p.symbol);
              return (
                <tr key={`${p.name}|${p.symbol}`} className="border-b border-border/40 align-top hover:bg-secondary/30" data-testid={`sigil-row-${p.symbol}`}>
                  <td className="max-w-[46vw] px-1.5 py-1.5 sm:max-w-none">
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      {a?.link ? (
                        <a href={a.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium hover:underline">
                          {p.name}
                          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                        </a>
                      ) : (
                        <span className="font-medium">{p.name}</span>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground">{p.symbol}</span>
                      {isUnverified(a) && <span className="rounded border border-amber-500/50 px-1 text-[9px] uppercase text-amber-500" title="Its identity is not confirmed">unverified</span>}
                      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                    </span>
                    {/* On a phone the columns that do not fit are a line under the name. */}
                    <span className="block text-[10px] text-muted-foreground lg:hidden">
                      {segmentOf(a)} · {ecoOf(a)}
                    </span>
                    {a?.note && <span className="block text-[10px] text-amber-500/90">{a.note}</span>}
                  </td>
                  <td className="hidden px-1.5 py-1.5 text-right font-mono md:table-cell">{qty(p.amount)}</td>
                  <td className="hidden px-1.5 py-1.5 text-right font-mono sm:table-cell">{price(p.priceUsd)}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono">{fmtAmount(p.totalUsd, 0)}</td>
                  <td className={`px-1.5 py-1.5 text-right font-mono ${tone(p.roi24h)}`}>{pct(p.roi24h)}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono text-muted-foreground">{p.share == null ? "—" : `${p.share.toFixed(1)}%`}</td>
                  <td className="hidden px-1.5 py-1.5 lg:table-cell">
                    <button type="button" className={`text-left hover:underline ${a?.segment ? "" : "text-amber-500"}`} onClick={() => setSegment(segmentOf(a))}>
                      {segmentOf(a)}
                    </button>
                  </td>
                  <td className="hidden px-1.5 py-1.5 lg:table-cell">
                    <button type="button" className="text-left hover:underline" onClick={() => setEco(ecoOf(a))}>
                      {ecoOf(a)}
                    </button>
                  </td>
                  <td className="hidden max-w-xs px-1.5 py-1.5 text-[11px] text-muted-foreground xl:table-cell">{a?.tldr ?? ""}</td>
                  <td className="whitespace-nowrap px-0.5 py-1 text-right">
                    <button type="button" className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground" title="Edit segment, ecosystem, link and note" onClick={() => setEditing(p)} data-testid={`sigil-edit-${p.symbol}`}>
                      <Pencil className="h-3 w-3" />
                    </button>
                    {enrich.enabled && (
                      <button type="button" className="hidden rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground sm:inline-block" title="Ask the AI to describe it again" disabled={busy} onClick={() => onEnrich(p.symbol)}>
                        <Sparkles className="h-3 w-3" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <AssetEditor symbol={editing.symbol} name={editing.name} asset={assets[editing.symbol]} lists={lists} onClose={() => setEditing(null)} />}
    </Card>
  );
}

/**
 * Sigil Core: a fund's holdings from the tracker's morning export, what
 * changed since the export before, and where it has been building or
 * leaving. Dropping the day's file anywhere on the page takes it in.
 */
export function SigilSection() {
  const page = useSigil();
  const upload = useSigilUpload();
  const seed = useSigilSeed();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const seedInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [report, setReport] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<string | null>(null);
  const [eco, setEco] = useState<string | null>(null);
  const d = page.data;

  const take = async (file: File | undefined | null) => {
    if (!file) return;
    setError(null);
    setReport(null);
    try {
      if (/\.zip$/i.test(file.name)) {
        const r = await seed.mutateAsync(file);
        toast({ title: "Seed pack loaded", description: `${r.snapshots} snapshots, ${r.changes} days of changes, ${r.history} history points, ${r.assets} assets.` });
        return;
      }
      if (!/\.csv$/i.test(file.name)) throw new Error(`${file.name} is not a Crypkit export: the export is a .csv file named Crypkit_portfolio-table_….csv.`);
      const r = await upload.mutateAsync(file);
      setReport(r.report);
      if (r.enriching.length) toast({ title: "Upload saved", description: `Describing ${r.enriching.length} new asset${r.enriching.length === 1 ? "" : "s"} in the background.` });
    } catch (err) {
      setError(said(err));
    }
  };
  const takeRef = useRef(take);
  takeRef.current = take;

  // The whole page is the drop target: a file dragged anywhere over it lands here.
  useEffect(() => {
    const hasFile = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      setOver(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      setOver(false);
      void takeRef.current(e.dataTransfer?.files?.[0]);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const latest = d?.latest ?? null;
  const assets = d?.assets ?? {};
  const derived = useMemo(() => {
    if (!latest) return null;
    return {
      movers: sigilMovers(latest.positions),
      bySegment: sigilGroups(latest.positions, assets, "segment"),
      byEco: sigilGroups(latest.positions, assets, "eco"),
      streaks: sigilStreaks(d?.changes ?? []),
      uncategorized: latest.positions.filter((p) => !assets[p.symbol]?.segment).length,
    };
  }, [latest, assets, d?.changes]);

  const busy = upload.isPending || seed.isPending;
  const strip = (
    <Card className={`border-dashed p-3 transition-colors sm:p-4 ${over ? "border-primary bg-primary/10" : "border-card-border bg-card"}`} data-testid="sigil-upload">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" className="h-9" onClick={() => input.current?.click()} disabled={busy} data-testid="sigil-pick">
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
          Upload today's export
        </Button>
        <p className="order-last min-w-0 basis-full text-[11px] text-muted-foreground sm:order-none sm:flex-1 sm:basis-0">{over ? "Drop it anywhere." : "Drop Crypkit_portfolio-table_….csv anywhere on this page, or pick it. Sending the same day twice replaces that day."}</p>
        <button type="button" className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => seedInput.current?.click()} data-testid="sigil-seed-pick">
          Load a seed pack (.zip)
        </button>
        {/* text/csv and the extension both: a phone's file picker greys out a .csv it has no type for. */}
        <input ref={input} type="file" accept=".csv,text/csv,text/comma-separated-values,application/vnd.ms-excel" className="hidden" onChange={(e) => (void take(e.target.files?.[0]), (e.target.value = ""))} data-testid="sigil-file" />
        <input ref={seedInput} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => (void take(e.target.files?.[0]), (e.target.value = ""))} data-testid="sigil-seed-file" />
      </div>
      {error && (
        <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-400" data-testid="sigil-upload-error">
          {error}
        </p>
      )}
      {report && (
        <div className="mt-2 rounded border border-border/60 bg-secondary/30 px-2 py-1.5">
          <ReportLines lines={report} />
        </div>
      )}
    </Card>
  );

  if (page.isLoading) return <p className="py-6 text-center text-xs text-muted-foreground">Reading…</p>;
  if (!latest || !derived)
    return (
      <div className="space-y-3" data-testid="section-sigil">
        {strip}
        <p className="text-xs text-muted-foreground">Nothing here yet. Load the seed pack to bring the history in, or upload the first export.</p>
      </div>
    );

  const prev = d!.previous;
  const delta = prev ? latest.portfolioValueUsd - prev.valueUsd : null;
  const deltaPct = prev && prev.valueUsd > 0 ? (latest.portfolioValueUsd / prev.valueUsd - 1) * 100 : null;
  const age = dayGap(pragueDay(new Date().toISOString()), latest.day);
  const valueBefore = (date: string) => d!.history.filter((h) => h.date < date).slice(-1)[0]?.valueUsd ?? null;
  const live = derived.streaks.filter((s) => s.live);
  const past = derived.streaks.filter((s) => !s.live).slice(0, 6);
  const streakLine = (s: (typeof derived.streaks)[number]) => (
    <li key={`${s.symbol}-${s.steps[0].date}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1" data-testid={`sigil-streak-${s.symbol}`}>
      <span className={`inline-flex items-center gap-1 font-semibold ${s.direction === "up" ? "text-emerald-400" : "text-red-400"}`}>
        {s.direction === "up" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
        {s.name} <span className="font-mono text-[10px] font-normal text-muted-foreground">{s.symbol}</span>
      </span>
      <span className="font-mono text-[11px]">{s.steps.map((x) => (x.pct === 100 && s.from === 0 && x === s.steps[0] ? "opened" : x.pct === -100 ? "closed" : pct(x.pct))).join(", ")}</span>
      <span className="text-[11px] text-muted-foreground">
        over {s.steps.length} updates ({s.steps[0].date.slice(5)} to {s.steps[s.steps.length - 1].date.slice(5)}){s.from > 0 && !s.ended ? `, ${pct(s.totalPct)} in all` : ""}
      </span>
    </li>
  );

  return (
    <div className="space-y-3" data-testid="section-sigil">
      {strip}

      <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="sigil-stats">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Portfolio value</p>
            <p className="font-mono text-2xl font-bold" data-testid="sigil-value">
              {fmtAmount(latest.portfolioValueUsd, 0)}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Since {prev ? prev.day.slice(5) : "—"}</p>
            <p className={`font-mono text-sm font-semibold ${tone(delta)}`} data-testid="sigil-delta">
              {delta == null ? "—" : `${delta >= 0 ? "+" : "−"}${fmtAmount(Math.abs(delta), 0)} (${pct(deltaPct, 2)})`}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Positions</p>
            <p className="font-mono text-sm font-semibold">{latest.positionCount}</p>
          </div>
          <div className="ml-auto text-right">
            <p className="font-mono text-[11px] text-muted-foreground">Snapshot {new Date(latest.capturedAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
            {age > 1 && (
              <p className="mt-0.5 inline-flex items-center gap-1 rounded border border-amber-500/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-500" data-testid="sigil-stale">
                <AlertTriangle className="h-3 w-3" />
                {age} days old
              </p>
            )}
          </div>
        </div>
        <div className="mt-3">
          <ValueLine points={d!.history.map((h) => ({ label: h.date, value: h.valueUsd }))} format={(v) => fmtAmount(v, 0)} testId="sigil-history" />
        </div>
      </Card>

      <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="sigil-streaks">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Positioning streaks</p>
        <p className="mb-1 text-[11px] text-muted-foreground">Names sized the same way on two or more updates in a row, by amount held.</p>
        {live.length ? <ul className="divide-y divide-border/40 text-xs">{live.map(streakLine)}</ul> : <p className="py-1 text-xs text-muted-foreground">No streak is running as of the latest update.</p>}
        {past.length > 0 && (
          <div className="mt-2" data-testid="sigil-streaks-ended">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Recently ended</p>
            <ul className="divide-y divide-border/40 text-xs opacity-85">{past.map(streakLine)}</ul>
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="sigil-movers">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Movers, 24h</p>
          {(["up", "down"] as const).map((k) => (
            <p key={k} className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              <span className="w-10 text-muted-foreground">{k === "up" ? "Up" : "Down"}</span>
              {derived.movers[k].length ? (
                derived.movers[k].map((m) => (
                  <span key={m.symbol + m.name}>
                    {m.name} <span className={`font-mono ${tone(m.roi24h)}`}>{pct(m.roi24h)}</span> <span className="font-mono text-muted-foreground">({fmtAmount(m.totalUsd, 0)})</span>
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </p>
          ))}
          {(["bySegment", "byEco"] as const).map((k) => (
            <div key={k} className="mt-2">
              <p className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{k === "bySegment" ? "By segment, weighted by value" : "By ecosystem, weighted by value"}</p>
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                {derived[k]
                  .filter((g) => g.roi24h != null)
                  .slice(0, 10)
                  .map((g) => (
                    <span key={g.key}>
                      {g.key} <span className={`font-mono ${tone(g.roi24h)}`}>{pct(g.roi24h)}</span>
                    </span>
                  ))}
              </p>
            </div>
          ))}
        </Card>
        <Card className="grid gap-4 border-card-border bg-card p-3 sm:grid-cols-2 sm:p-4" data-testid="sigil-donuts">
          <Donut title="By segment" slices={derived.bySegment.map((g) => ({ key: g.key, value: g.valueUsd }))} picked={segment} onPick={setSegment} format={(v) => fmtAmount(v, 0)} testId="sigil-donut-segment" />
          <Donut title="By ecosystem" slices={derived.byEco.map((g) => ({ key: g.key, value: g.valueUsd }))} picked={eco} onPick={setEco} format={(v) => fmtAmount(v, 0)} testId="sigil-donut-eco" />
        </Card>
      </div>

      {(derived.uncategorized > 0 || d!.enrich.error) && (
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-amber-500" data-testid="sigil-uncategorized">
          {derived.uncategorized > 0 && (
            <button type="button" className="underline underline-offset-2" onClick={() => (setSegment("Uncategorized"), setEco(null))}>
              {derived.uncategorized} holding{derived.uncategorized === 1 ? " is" : "s are"} uncategorized
            </button>
          )}
          {d!.enrich.running.length > 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <RefreshCw className="h-3 w-3 animate-spin" /> describing {d!.enrich.running.join(", ")}
            </span>
          )}
          {!d!.enrich.enabled && derived.uncategorized > 0 && <span className="text-muted-foreground">The AI that describes new assets needs ANTHROPIC_API_KEY on the server; until then, edit them by hand.</span>}
          {d!.enrich.error && <span>The last AI description failed: {d!.enrich.error}</span>}
        </p>
      )}

      <Holdings positions={latest.positions} assets={assets} lists={d!.lists} enrich={d!.enrich} segment={segment} eco={eco} setSegment={setSegment} setEco={setEco} />

      <div data-testid="sigil-changes">
        <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Change log</p>
        {/* A window onto the days, so the section under this one is not a long scroll away. */}
        <div className="max-h-[34rem] space-y-1.5 overflow-y-auto pr-1">
          {d!.changes.slice(0, 120).map((c, i) => (
            <ChangeCard key={c.date} change={c} previousValue={valueBefore(c.date)} recent={i < 7} />
          ))}
        </div>
      </div>
    </div>
  );
}
