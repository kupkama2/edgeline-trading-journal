import { useAccountBalances, useAddAccountBalance, useBinanceSync, useHyperliquidSync } from "@/lib/data";
import { isWalletAddress, venueOfAccount } from "@shared/hyperliquid";
import { fmtAmount } from "@shared/metrics";
import { latestEquity } from "@shared/equity";
import { useMemo, useState } from "react";
import { MembersCard } from "@/components/members-card";
import { SyncReportDialog } from "@/components/sync-report";
import type { SyncSummary } from "@/lib/data";
import { usePublicMode } from "@/lib/public-mode";
import { MarketsCard } from "@/components/markets-card";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { BookOpen, Check, Eye, EyeOff, Pencil, Plus, RotateCcw, Trash2, X, ShieldAlert, Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { spanLabel, spanRange, useChapters, useDeleteChapter, useStartChapter } from "@/lib/chapters";
import { inSpan } from "@shared/chapters";
import { usePrefs, useSetPrefs } from "@/lib/prefs";
import { DEFAULT_GUARDRAILS, guardRailsProblem, type GuardRails } from "@shared/guardrails";
import type { ReviewMode } from "@shared/review-pressure";
import { DateTime24, Segmented, localNow, toIso } from "@/components/trade-shared";
import {
  useMistakeTags,
  useCreateTag,
  useUpdateTag,
  useDeleteTag,
  useAllTrades,
  useStyles,
  useCreateStyle,
  useUpdateStyle,
  useStorageUsage,
  useDeleteStyle,
  useAccountSettings,
  useMergeAccounts,
  useSaveAccountSettings,
  useTrackNow,
} from "@/lib/data";
import { STYLE_COLOR_NAMES, styleColor } from "@/lib/style-filter";
import {
  getPrestige,
  fmtMoney,
  mistakeCostLeaderboard,
} from "@shared/metrics";

/**
 * Fee schedule per account. One row per account name — the names come from
 * the trades themselves plus anything configured before its first trade.
 * Maker = limit orders, taker = market orders, always per side; the mode
 * decides whether the numbers read as % of notional (crypto) or dollars per
 * contract (futures). The Close dialog turns these into one-click fee
 * suggestions.
 */
function AccountFeesRow({
  name,
  existing,
  others,
}: {
  name: string;
  existing:
    | {
        feeMode: string;
        makerFee: number;
        takerFee: number;
        kind?: string;
        wallet?: string | null;
        /** "…ab12" when a Binance key is held. The key itself never comes back. */
        binanceKeyHint?: string | null;
        /** False when the key is stored but this server cannot open its secret (SESSION_SECRET changed). */
        binanceKeyReadable?: boolean | null;
        /** The relay's token, when the account's Binance calls go through a relay on the trader's own machine. */
        relayToken?: string | null;
        relay?: { connected: boolean; lastSeenAt: string | null; env: string | null; canTrade: boolean | null } | null;
        binanceEnv?: string;
        binanceTrade?: boolean;
        /** The journal follows this account on its venue and writes what it does. */
        track?: boolean;
      }
    | undefined;
  /** The other accounts, for folding a passed evaluation into one of them. */
  others: string[];
}) {
  const save = useSaveAccountSettings();
  const sync = useHyperliquidSync();
  const bnSync = useBinanceSync();
  const trackNow = useTrackNow();
  const { data: balances = [] } = useAccountBalances();
  const addBalance = useAddAccountBalance();
  const [wallet, setWallet] = useState(existing?.wallet ?? "");
  // The key and its secret are typed, sent once, and forgotten here: the
  // server keeps the key and a sealed secret, and hands back only how the
  // key ends. Nothing in this component ever holds a saved secret.
  const [bnKey, setBnKey] = useState("");
  const [bnSecret, setBnSecret] = useState("");
  const [bnOpen, setBnOpen] = useState(false);
  /** What the key is for: the sync alone, or the terminal — on the live venue or its testnet. */
  const [keyMode, setKeyMode] = useState<"read" | "trade-live" | "trade-testnet">("read");
  /** The last sync's trade-by-trade account, open until it has been looked at. */
  const [report, setReport] = useState<{ venue: string; account: SyncSummary["accounts"][number] } | null>(null);
  const [balance, setBalance] = useState("");
  const equity = latestEquity(balances, name);
  const walletDirty = (existing?.wallet ?? "") !== wallet.trim();
  const walletOk = wallet.trim() === "" || isWalletAddress(wallet);
  const looksHl = venueOfAccount(name) === "hyperliquid";
  const looksBn = venueOfAccount(name) === "binance";
  const bnReady = bnKey.trim().length >= 16 && bnSecret.trim().length >= 16;

  /*
   * The fees as STORED, for every save that is not about fees. Each of these
   * used to send the fee boxes as they stood — so clearing the maker fee to
   * retype it and then saving a wallet saved a maker fee of zero.
   */
  const storedFees = () => ({
    name,
    feeMode: (existing?.feeMode === "perContract" ? "perContract" : "percent") as "percent" | "perContract",
    makerFee: existing?.makerFee ?? 0,
    takerFee: existing?.takerFee ?? 0,
  });
  /** Run a save; on failure say so and return null, so no success toast follows. */
  async function attempt<T>(title: string, fn: () => Promise<T>): Promise<{ value: T } | null> {
    try {
      return { value: await fn() };
    } catch (err: any) {
      toast({ title, description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 220), variant: "destructive" });
      return null;
    }
  }

  async function saveWallet() {
    if (!(await attempt("Wallet not saved", () => save.mutateAsync({ ...storedFees(), wallet: wallet.trim() || null }))))
      return;
    toast({
      title: wallet.trim() ? "Wallet saved" : "Wallet cleared",
      description: wallet.trim()
        ? `${name} will sync its fills from Hyperliquid.`
        : `${name} is back to trades logged by hand.`,
    });
  }

  /** One sentence for what a sync did, whichever venue did it. */
  function sayWhatHappened(venue: string, r: { accounts: any[]; message?: string }, fallback: string) {
    const a = r.accounts[0];
    if (!a) return toast({ title: "Nothing synced", description: r.message ?? fallback });
    const parts = [
      `${a.created} new`,
      // The claimed count is the one worth reading after a month of logging
      // by hand: it is the trades the venue recognised as already yours.
      ...(a.claimed ? [`${a.claimed} matched to trades you had logged`] : []),
      `${a.updated} updated`,
      `${a.unchanged} unchanged`,
      ...(a.unreconstructed ? [`${a.unreconstructed} fill${a.unreconstructed === 1 ? "" : "s"} from before the record`] : []),
    ];
    const summary = `${a.fills} fills read — ${parts.join(", ")}.`;
    // An error beside a partial result is still a result; it is said after.
    if (a.error && a.fills === 0) return toast({ title: `${venue} did not answer`, description: a.error, variant: "destructive" });
    // Anything read is shown in full: what was written, trade by trade, and
    // what the venue sent, market by market — a sync that wrote nothing is
    // the one whose answer most needs reading, because a trade that is not
    // in the journal is either absent from the venue's answer or in it and
    // set aside, and only the list says which. An empty answer is a toast.
    if (a.written.length > 0 || a.fills > 0) return setReport({ venue, account: a });
    toast({ title: `Synced ${name}`, description: a.error ? `${summary} ${a.error}` : summary });
  }

  async function syncNow() {
    const r = await attempt("Hyperliquid sync failed", () => sync.mutateAsync(name));
    if (r) sayWhatHappened("Hyperliquid", r.value, "No wallet on this account.");
  }

  async function saveBinanceKey() {
    try {
      await save.mutateAsync({
        ...storedFees(),
        binanceKey: bnKey.trim(),
        binanceSecret: bnSecret.trim(),
        binanceEnv: keyMode === "trade-testnet" ? "testnet" : "live",
        binanceTrade: keyMode !== "read",
      } as any);
      setBnKey("");
      setBnSecret("");
      setBnOpen(false);
      toast({
        title: "Key saved",
        description:
          keyMode === "read"
            ? `${name} will sync its positions from Binance. The key was checked: it can read, and it cannot spend.`
            : keyMode === "trade-testnet"
              ? `${name} trades on the Binance futures testnet from the terminal.`
              : `${name} trades on Binance from the terminal. The key was checked: futures on, withdrawals off, locked to an IP.`,
      });
    } catch (err: any) {
      // The server's refusal is the useful part — "this key can withdraw" is
      // an instruction, and it must not be flattened into "didn't save".
      toast({ title: "Key not kept", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 220), variant: "destructive" });
    }
  }

  async function clearBinanceKey() {
    if (!(await attempt("Key not removed", () => save.mutateAsync({ ...storedFees(), binanceKey: null } as any)))) return;
    toast({ title: "Key removed", description: `${name} is back to trades logged by hand.` });
  }

  async function syncBinanceNow() {
    const r = await attempt("Binance sync failed", () => bnSync.mutateAsync(name));
    if (r) sayWhatHappened("Binance", r.value, "No key on this account.");
  }

  async function logBalance() {
    const v = Number(balance.replace(/[,$\s]/g, ""));
    if (!Number.isFinite(v) || v < 0) return;
    if (!(await attempt("Balance not logged", () => addBalance.mutateAsync({ account: name, balance: v })))) return;
    setBalance("");
    toast({ title: "Balance logged", description: `${name} is ${fmtAmount(v, 0)} as of now.` });
  }
  const merge = useMergeAccounts();
  const { toast } = useToast();
  const isEval = existing?.kind === "evaluation";
  const [mergeInto, setMergeInto] = useState("");
  const [mode, setMode] = useState<"percent" | "perContract">(
    existing?.feeMode === "perContract" ? "perContract" : "percent",
  );
  const [maker, setMaker] = useState(existing != null ? String(existing.makerFee) : "");
  const [taker, setTaker] = useState(existing != null ? String(existing.takerFee) : "");
  const dirty =
    (existing?.feeMode ?? "percent") !== mode ||
    String(existing?.makerFee ?? "") !== (maker.trim() === "" ? "" : String(Number(maker))) ||
    String(existing?.takerFee ?? "") !== (taker.trim() === "" ? "" : String(Number(taker)));

  async function persist() {
    const m = Number(maker) || 0;
    const t = Number(taker) || 0;
    if (!(await attempt("Fees not saved", () => save.mutateAsync({ name, feeMode: mode, makerFee: m, takerFee: t })))) return;
    toast({ title: "Fees saved", description: `${name} — schedule updated.` });
  }

  /** Route this account's Binance calls through a relay on the trader's own machine, or stop. */
  async function setRelay(relay: boolean) {
    if (!(await attempt("Not changed", () => save.mutateAsync({ ...storedFees(), relay })))) return;
    toast({
      title: relay ? "Relay ready" : "Relay removed",
      description: relay ? "Run the relay on your machine with the command shown; the key stays there." : `${name} will use a key stored here again, once you save one.`,
    });
  }
  const [relayOpen, setRelayOpen] = useState(false);

  /** Watch this account on its venue, or stop. */
  async function setTrack(track: boolean) {
    if (!(await attempt("Not changed", () => save.mutateAsync({ ...storedFees(), track })))) return;
    toast({
      title: track ? "Tracking on" : "Tracking off",
      description: track
        ? `${name} is read every few seconds: positions become trades, moves and partials are written as they happen.`
        : `${name} is no longer followed. Trades already written stay.`,
    });
  }

  async function runTrackNow() {
    const r = await attempt("Tracking pass failed", () => trackNow.mutateAsync());
    if (!r) return;
    const mine = r.value.accounts.find((a) => a.account === name);
    if (!mine) return toast({ title: "Nothing to track", description: `${name} is not being watched.` });
    if (mine.error) return toast({ title: `${name} could not be read`, description: mine.error, variant: "destructive" });
    toast({
      title: "Tracking pass done",
      description: `${mine.opened.length} ${mine.opened.length === 1 ? "position" : "positions"} newly written, ${mine.read} ${mine.read === 1 ? "open trade" : "open trades"} read back.`,
    });
  }

  async function setKind(kind: "live" | "evaluation") {
    if (!(await attempt("Not changed", () => save.mutateAsync({ ...storedFees(), kind })))) return;
    toast({
      title: kind === "evaluation" ? "Held out of the record" : "Counting again",
      description:
        kind === "evaluation"
          ? `${name} no longer counts towards your stats unless you open it.`
          : `${name} is funded — its trades join the book.`,
    });
  }

  async function foldInto(into: string) {
    const r = await attempt("Not merged", () => merge.mutateAsync({ from: name, into }));
    setMergeInto("");
    if (!r) return;
    const { moved } = r.value;
    toast({
      title: `Merged into ${into}`,
      description: `${moved} ${moved === 1 ? "trade" : "trades"} moved. ${name} is gone.`,
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-2.5 py-2"
      data-testid={`account-fees-${name}`}
    >
      <span className="min-w-[7rem] text-xs font-medium">{name}</span>
      <div className="flex gap-0.5">
        {(
          [
            { k: "percent", l: "% notional" },
            { k: "perContract", l: "per contract" },
          ] as const
        ).map(({ k, l }) => (
          <button
            key={k}
            type="button"
            onClick={() => setMode(k)}
            data-testid={`button-fee-mode-${name}-${k}`}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              mode === k
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {l}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
        limit
        <Input
          value={maker}
          onChange={(e) => setMaker(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="h-7 w-20 font-mono text-[11px]"
          data-testid={`input-maker-${name}`}
        />
      </label>
      <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
        market
        <Input
          value={taker}
          onChange={(e) => setTaker(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="h-7 w-20 font-mono text-[11px]"
          data-testid={`input-taker-${name}`}
        />
      </label>
      <span className="text-[10px] text-muted-foreground">per side</span>
      {dirty && (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 px-2 text-[11px]"
          onClick={persist}
          disabled={save.isPending}
          data-testid={`button-save-fees-${name}`}
        >
          <Check className="mr-1 h-3 w-3" />
          Save
        </Button>
      )}

      {/*
        What the account is WORTH, and where its trades come from.

        The balance is a snapshot, logged: deposits and withdrawals move it
        in ways the journal cannot see, so it is never computed. Once one is
        logged, every risk figure gains a percentage beside its dollars. The
        wallet is only offered where the name suggests a venue that has one;
        with it saved, the venue writes this account's trades itself.
      */}
      <div
        className="flex w-full flex-wrap items-center gap-2 border-t border-border/40 pt-1.5 text-[10px]"
        data-testid={`account-equity-${name}`}
      >
        <span className="text-muted-foreground">
          {equity != null ? (
            <>
              balance <span className="font-mono text-foreground">{fmtAmount(equity, 0)}</span>
            </>
          ) : (
            "no balance logged — risk shows in dollars only"
          )}
        </span>
        <Input
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          inputMode="decimal"
          placeholder={equity != null ? "new balance" : "balance now"}
          className="h-7 w-28 font-mono text-[11px]"
          data-testid={`input-balance-${name}`}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={logBalance}
          disabled={addBalance.isPending || balance.trim() === ""}
          data-testid={`button-log-balance-${name}`}
        >
          Log
        </Button>

        {(looksHl || existing?.wallet) && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <Input
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="0x… Hyperliquid wallet"
              spellCheck={false}
              className={`h-7 w-56 max-w-full font-mono text-[11px] ${walletOk ? "" : "border-primary/60"}`}
              data-testid={`input-wallet-${name}`}
            />
            {walletDirty && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={saveWallet}
                disabled={save.isPending || !walletOk}
                data-testid={`button-save-wallet-${name}`}
              >
                <Check className="mr-1 h-3 w-3" />
                Save
              </Button>
            )}
            {existing?.wallet && !walletDirty && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={syncNow}
                disabled={sync.isPending}
                data-testid={`button-sync-${name}`}
              >
                {sync.isPending ? "Syncing…" : "Sync fills"}
              </Button>
            )}
          </span>
        )}

        {/*
          Binance has no public record by address; its history is behind a
          key. So the key goes here, read-only by rule — the server asks the
          venue what the key may do and refuses one that can withdraw or
          trade — and once kept, the venue writes this account's positions
          the same way a wallet does. The secret is typed, sent, and gone:
          what comes back is the key's last four characters and nothing else.
        */}
        {/* Not while a relay holds the key: there is nothing here to replace or remove. */}
        {(looksBn || existing?.binanceKeyHint) && !existing?.relayToken && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5" data-testid={`binance-key-${name}`}>
            {existing?.binanceKeyHint && !bnOpen ? (
              <>
                <span className="font-mono text-[11px] text-muted-foreground" data-testid={`text-binance-key-${name}`}>
                  key {existing.binanceKeyHint}
                </span>
                {existing.binanceKeyReadable === false && (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-400" data-testid={`text-binance-key-unreadable-${name}`}>
                    cannot be opened on this server — enter it again
                  </span>
                )}
                {existing.binanceTrade && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                      existing.binanceEnv === "testnet" ? "bg-amber-500/15 text-amber-500" : "bg-red-500/15 text-red-400"
                    }`}
                    data-testid={`badge-binance-trading-${name}`}
                  >
                    {existing.binanceEnv === "testnet" ? "testnet · trading" : "live · trading"}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={syncBinanceNow}
                  disabled={bnSync.isPending}
                  data-testid={`button-sync-binance-${name}`}
                >
                  {bnSync.isPending ? "Syncing…" : "Sync positions"}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => setBnOpen(true)} data-testid={`button-replace-binance-key-${name}`}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={clearBinanceKey} disabled={save.isPending} data-testid={`button-clear-binance-key-${name}`}>
                  Remove
                </Button>
              </>
            ) : (
              <>
                <Segmented
                  size="xs"
                  value={keyMode}
                  onChange={setKeyMode}
                  ariaLabel="What the key is for"
                  options={[
                    { id: "read", label: "read-only", testId: `button-key-mode-read-${name}` },
                    { id: "trade-live", label: "trading", title: "Places orders from the terminal on the live venue", testId: `button-key-mode-live-${name}` },
                    { id: "trade-testnet", label: "testnet", title: "A futures testnet key: play money, for the terminal", testId: `button-key-mode-testnet-${name}` },
                  ]}
                />
                <Input
                  value={bnKey}
                  onChange={(e) => setBnKey(e.target.value)}
                  placeholder={keyMode === "read" ? "Binance API key (read-only)" : keyMode === "trade-testnet" ? "Testnet API key" : "Binance API key (trading)"}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-7 w-52 max-w-full font-mono text-[11px]"
                  data-testid={`input-binance-key-${name}`}
                />
                <Input
                  value={bnSecret}
                  onChange={(e) => setBnSecret(e.target.value)}
                  placeholder="secret"
                  type="password"
                  spellCheck={false}
                  autoComplete="new-password"
                  className="h-7 w-40 max-w-full font-mono text-[11px]"
                  data-testid={`input-binance-secret-${name}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={saveBinanceKey}
                  disabled={save.isPending || !bnReady}
                  data-testid={`button-save-binance-key-${name}`}
                >
                  <Check className="mr-1 h-3 w-3" />
                  {save.isPending ? "Checking…" : "Save"}
                </Button>
                {bnOpen && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => setBnOpen(false)}>
                    Cancel
                  </Button>
                )}
                <span className="basis-full text-[10px] leading-snug text-muted-foreground">
                  {keyMode === "read" ? (
                    <>
                      Make it in Binance under API Management with only <em>Enable Reading</em> ticked —
                      that is all the sync needs, futures history included. A key that can withdraw,
                      transfer, or place spot or margin orders is refused.
                    </>
                  ) : keyMode === "trade-testnet" ? (
                    <>
                      A key from the Binance futures testnet, for the terminal. Play money; it is checked by
                      reading the testnet balance with it.
                    </>
                  ) : (
                    <>
                      A key the terminal places orders with. It must have <em>Enable Futures</em> on,
                      withdrawals and transfers off, and be restricted to the server's IP — the venue is
                      asked, and a key that fails any of those is refused.
                    </>
                  )}
                </span>
              </>
            )}
          </span>
        )}
      </div>
      {report && (
        <SyncReportDialog venue={report.venue} account={report.account} onClose={() => setReport(null)} />
      )}

      {/*
        The relay: Binance asked from the trader's own machine.

        A hosted server is refused by Binance for its address — a US host,
        or an outbound IP it shares with strangers who got it rate-banned.
        The trader's own connection is refused nothing. So the key can live
        on their machine, in a small program that keeps one connection open
        to here and makes every Binance call for this account from there.
      */}
      {(looksBn || existing?.binanceKeyHint || existing?.relayToken) && (
        <div className="flex w-full flex-wrap items-center gap-2 border-t border-border/40 pt-1.5 text-[10px]" data-testid={`relay-row-${name}`}>
          {existing?.relayToken ? (
            <>
              <span
                className={`rounded-full border px-2 py-0.5 ${existing.relay?.connected ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-500" : "border-amber-500/50 bg-amber-500/10 text-amber-500"}`}
                data-testid={`text-relay-status-${name}`}
              >
                {existing.relay?.connected
                  ? `relay connected${existing.relay.env === "testnet" ? " · testnet" : ""}${existing.relay.canTrade ? " · may trade" : " · read-only"}`
                  : existing.relay?.lastSeenAt
                    ? `relay not connected — last seen ${new Date(existing.relay.lastSeenAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", hour12: false })}`
                    : "relay not connected yet"}
              </span>
              <span className="text-muted-foreground">Binance is asked from your machine; the key stays there.</span>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setRelayOpen((v) => !v)} data-testid={`button-relay-how-${name}`}>
                {relayOpen ? "Hide" : "How to run it"}
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px] text-muted-foreground" onClick={() => setRelay(false)} disabled={save.isPending} data-testid={`button-relay-off-${name}`}>
                Stop using the relay
              </Button>
              {relayOpen && (
                <div className="basis-full space-y-1.5 rounded-md border border-border/60 bg-background/60 p-2" data-testid={`relay-howto-${name}`}>
                  <p className="text-muted-foreground">
                    On any machine that stays on — your PC, a Raspberry Pi, a free VM — with Node 22 or newer. The key is typed there and never sent here.
                  </p>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-secondary/60 p-2 font-mono text-[10px] leading-relaxed" data-testid={`text-relay-command-${name}`}>
{`curl -O ${window.location.origin}/relay/edgeline-relay.mjs
EDGELINE_URL=${window.location.origin} \
EDGELINE_RELAY_TOKEN=${existing.relayToken} \
BINANCE_KEY=<your api key> BINANCE_SECRET=<your secret> \
node edgeline-relay.mjs`}
                  </pre>
                  <p className="text-muted-foreground">
                    Or, on a Linux server that stays on — a free Oracle Cloud VM does — as a service that starts at boot and restarts itself:
                  </p>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-secondary/60 p-2 font-mono text-[10px] leading-relaxed" data-testid={`text-relay-install-${name}`}>
{`curl -fsSL ${window.location.origin}/relay/install.sh | sudo \
EDGELINE_URL=${window.location.origin} \
EDGELINE_RELAY_TOKEN=${existing.relayToken} \
BINANCE_KEY=<your api key> BINANCE_SECRET=<your secret> bash`}
                  </pre>
                  <p className="text-muted-foreground">
                    Add <span className="font-mono">BINANCE_ENV=testnet</span> for a testnet key. The relay reads the account, not the device: trades placed from any phone, laptop or terminal are seen, as long as the relay is running somewhere. The row turns green when it is connected; tracking and the terminal then work through it.
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setRelay(true)}
                disabled={save.isPending}
                className="rounded-full border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                data-testid={`button-relay-on-${name}`}
              >
                use a relay instead of a key here
              </button>
              <span className="text-muted-foreground">
                For when Binance refuses this server&apos;s address: a small program on your own machine makes the calls, and the key never leaves it.
              </span>
            </>
          )}
        </div>
      )}

      {/*
        Whether the journal FOLLOWS the account, not only reads it when asked.

        A sync writes what has already happened. Tracking reads the venue
        every few seconds: a position that appears becomes an open trade, the
        stop and the target resting against it are its idea, and each move,
        partial and add is written as it happens with the mark at the time —
        so a trade made in the venue's own app, or in any terminal, is in the
        record as one trade with its management, the same as one sent from here.
      */}
      {(existing?.wallet || existing?.binanceKeyHint || existing?.relayToken) && (
        <div className="flex w-full flex-wrap items-center gap-2 border-t border-border/40 pt-1.5 text-[10px]" data-testid={`track-row-${name}`}>
          <button
            type="button"
            onClick={() => setTrack(!existing?.track)}
            disabled={save.isPending}
            className={`rounded-full border px-2 py-0.5 transition-colors ${
              existing?.track
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-500"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
            data-testid={`button-track-${name}`}
          >
            {existing?.track ? "tracking live — every position is logged as it is managed" : "track live"}
          </button>
          {existing?.track ? (
            <>
              <span className="text-muted-foreground">
                {existing.wallet ? "Read by wallet address." : existing.relayToken ? "Read through your relay." : existing.binanceTrade ? "Read with the trading key." : "Read with the read-only key."} Stops, targets, partials and adds are written as they change.
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-[10px]"
                onClick={runTrackNow}
                disabled={trackNow.isPending}
                data-testid={`button-track-now-${name}`}
              >
                {trackNow.isPending ? "Reading…" : "Read now"}
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground">
              Positions opened anywhere — the venue's app, any terminal — become trades here, with how they were managed.
            </span>
          )}
        </div>
      )}

      {/*
        What the account IS, which decides whether it counts.

        An evaluation is somebody else's money under somebody else's rules —
        a drawdown limit and a profit target that change how a trade gets
        managed. Averaged into the live record it is not a bigger sample, it
        is a different game contaminating the one being measured, and the
        damage is invisible because the numbers still look like numbers.
      */}
      <div className="flex w-full flex-wrap items-center gap-2 border-t border-border/40 pt-1.5 text-[10px]">
        <button
          type="button"
          onClick={() => setKind(isEval ? "live" : "evaluation")}
          className={`rounded-full border px-2 py-0.5 transition-colors ${
            isEval
              ? "border-amber-500/50 bg-amber-500/10 text-amber-500"
              : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
          }`}
          data-testid={`button-account-kind-${name}`}
        >
          {isEval ? "evaluation — held out of your stats" : "mark as an evaluation"}
        </button>

        {isEval && (
          <>
            <span className="text-muted-foreground">
              Opening it in the account filter still shows it.
            </span>
            {/* Passing an eval usually means a NEW funded account with a new
                name. The trades that got you there are real and belong in the
                record — they were only ever logged under the name the account
                had at the time. */}
            {others.length > 0 && (
              <span className="ml-auto flex items-center gap-1.5">
                <span className="text-muted-foreground">Passed it? Fold into</span>
                <select
                  value={mergeInto}
                  onChange={(e) => setMergeInto(e.target.value)}
                  className="rounded border border-border bg-transparent px-1.5 py-0.5 text-[10px]"
                  data-testid={`select-merge-${name}`}
                >
                  <option value="">choose…</option>
                  {others.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                {/* Merging moves every trade and deletes this account's
                    settings, and there is no undo — so picking a name only
                    asks; this button does it. */}
                {mergeInto && (
                  <>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-6 px-2 text-[10px]"
                      disabled={merge.isPending}
                      onClick={() => void foldInto(mergeInto)}
                      data-testid={`button-merge-confirm-${name}`}
                    >
                      Move all into {mergeInto}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setMergeInto("")}>
                      Cancel
                    </Button>
                  </>
                )}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AccountFeesCard() {
  const { data: trades = [] } = useAllTrades();
  const { data: settings = [] } = useAccountSettings();
  const [newName, setNewName] = useState("");
  const [added, setAdded] = useState<string[]>([]);

  const names = useMemo(() => {
    const s = new Set<string>();
    for (const t of trades) if (t.account?.trim()) s.add(t.account.trim());
    for (const cfg of settings) s.add(cfg.name);
    for (const a of added) s.add(a);
    return Array.from(s).sort();
  }, [trades, settings, added]);

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-account-fees">
      <h2 className="text-sm font-semibold tracking-tight">Accounts</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Commission per side — limit (maker) and market (taker) separately; the Close
        dialog uses these to suggest a fee and you can always overtype it. And what
        each account IS: an evaluation is held out of your stats until you open it,
        because somebody else's drawdown limit is a different game and averaging the
        two measures neither.
      </p>
      <div className="mt-3 space-y-2">
        {names.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            No accounts yet — log a trade with an account, or add one below.
          </p>
        )}
        {names.map((n) => (
          <AccountFeesRow
            key={`${n}:${settings.find((s) => s.name === n)?.id ?? "new"}`}
            name={n}
            existing={settings.find((s) => s.name === n)}
            others={names.filter((o) => o !== n)}
          />
        ))}
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="add an account…"
            className="h-8 w-48 text-xs"
            data-testid="input-new-fee-account"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-[11px]"
            disabled={!newName.trim()}
            onClick={() => {
              setAdded((a) => [...a, newName.trim()]);
              setNewName("");
            }}
            data-testid="button-add-fee-account"
          >
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        </div>
      </div>
    </Card>
  );
}

function StylesCard() {
  const { toast } = useToast();
  const { data: styles = [], isLoading } = useStyles();
  const { data: trades = [] } = useAllTrades();
  const createStyle = useCreateStyle();
  const updateStyle = useUpdateStyle();
  const deleteStyle = useDeleteStyle();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const counts = useMemo(() => {
    const acc: Record<number, number> = {};
    for (const t of trades) {
      if (t.styleId != null) acc[t.styleId] = (acc[t.styleId] ?? 0) + 1;
    }
    return acc;
  }, [trades]);

  async function add() {
    const name = newName.trim();
    if (!name) return;
    const color = STYLE_COLOR_NAMES[styles.length % STYLE_COLOR_NAMES.length];
    await createStyle.mutateAsync({ name, color, sortOrder: styles.length });
    setNewName("");
    toast({ title: "Style added", description: name });
  }

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold tracking-tight">Trading styles</h2>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Each style is its own book — stats, demon streaks and the guardrail lock are tracked
        separately, so a losing run in one never halts the other. Deleting a style keeps its
        trades and marks them unassigned.
      </p>

      <div className="mt-4 flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="New style — e.g. NQ scalps…"
          className="h-9 text-sm"
          data-testid="input-new-style"
        />
        <Button
          onClick={add}
          disabled={!newName.trim() || createStyle.isPending}
          className="h-9 shrink-0 gap-1 text-xs"
          data-testid="button-add-style"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      <div className="mt-4 space-y-1.5">
        {isLoading ? (
          <>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </>
        ) : styles.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-[11px] text-muted-foreground">
            No styles yet. Add one above to start separating your books.
          </p>
        ) : (
          styles.map((s) => {
            const editing = editingId === s.id;
            const c = styleColor(s.color);
            const used = counts[s.id] ?? 0;
            return (
              <div
                key={s.id}
                /* Wraps rather than overflows: the colour swatches and the
                   session-hour pair are each wide enough to push this row off
                   a phone screen if they are forced onto one line. */
                className="flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-secondary/25 px-3 py-2"
                data-testid={`row-style-${s.id}`}
              >
                {editing ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-8 text-sm"
                      data-testid={`input-edit-style-${s.id}`}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 text-emerald-400"
                      onClick={async () => {
                        if (editName.trim())
                          await updateStyle.mutateAsync({ id: s.id, name: editName.trim() });
                        setEditingId(null);
                      }}
                      data-testid={`button-save-style-${s.id}`}
                      aria-label="Save style"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${c.dot}`} />
                    <span className="min-w-0 flex-1 basis-24 truncate text-sm">{s.name}</span>

                    <div className="flex shrink-0 items-center gap-1">
                      {STYLE_COLOR_NAMES.map((name) => (
                        <button
                          key={name}
                          type="button"
                          aria-label={`Colour ${name}`}
                          onClick={() => updateStyle.mutate({ id: s.id, color: name })}
                          className={`h-3 w-3 rounded-full ${styleColor(name).dot} ${
                            s.color === name
                              ? "ring-2 ring-foreground/60 ring-offset-1 ring-offset-background"
                              : "opacity-40 hover:opacity-100"
                          }`}
                          data-testid={`button-style-color-${s.id}-${name}`}
                        />
                      ))}
                    </div>

                    {/* The hours this book trades. Typed as HH:MM; clearing
                        either field removes the window and its warnings. */}
                    <div className="flex shrink-0 items-center gap-1">
                      <input
                        type="time"
                        defaultValue={s.sessionStart ?? ""}
                        onBlur={(e) =>
                          updateStyle.mutate({
                            id: s.id,
                            sessionStart: e.target.value || null,
                          })
                        }
                        className="h-7 rounded border border-border bg-transparent px-1 font-mono text-[10px] text-muted-foreground"
                        title="Session start — entries before this warn"
                        data-testid={`input-session-start-${s.id}`}
                      />
                      <span className="text-[10px] text-muted-foreground">–</span>
                      <input
                        type="time"
                        defaultValue={s.sessionEnd ?? ""}
                        onBlur={(e) =>
                          updateStyle.mutate({
                            id: s.id,
                            sessionEnd: e.target.value || null,
                          })
                        }
                        className="h-7 rounded border border-border bg-transparent px-1 font-mono text-[10px] text-muted-foreground"
                        title="Session end — entries after this warn"
                        data-testid={`input-session-end-${s.id}`}
                      />
                    </div>

                    {/* How many entries a day this book allows. Past it, the
                        next entry is tilt unless argued in. Blank: no number. */}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      defaultValue={s.maxTradesPerDay ?? ""}
                      onBlur={(e) =>
                        updateStyle.mutate({
                          id: s.id,
                          maxTradesPerDay: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="h-7 w-16 shrink-0 rounded border border-border bg-transparent px-1 font-mono text-[10px] text-muted-foreground"
                      title="Max trades a day — past this, the next entry logs as tilt unless you argue it in"
                      placeholder="max/day"
                      data-testid={`input-max-trades-${s.id}`}
                    />

                    {/* What this book normally risks. The scalp log assumes
                        it, so a scalp can be logged as a ticker and a
                        result and still carry an R. */}
                    <input
                      type="number"
                      min={0}
                      step="any"
                      defaultValue={s.defaultRisk ?? ""}
                      onBlur={(e) =>
                        updateStyle.mutate({
                          id: s.id,
                          defaultRisk: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="h-7 w-16 shrink-0 rounded border border-border bg-transparent px-1 font-mono text-[10px] text-muted-foreground"
                      title="Usual risk in dollars — the scalp log assumes this when you don't type one"
                      placeholder="risk $"
                      data-testid={`input-default-risk-${s.id}`}
                    />

                    <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                      {used} {used === 1 ? "trade" : "trades"}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 text-muted-foreground"
                      onClick={() => {
                        setEditingId(s.id);
                        setEditName(s.name);
                      }}
                      data-testid={`button-edit-style-${s.id}`}
                      aria-label="Rename style"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {confirmingId === s.id ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 shrink-0 text-[11px]"
                        onClick={async () => {
                          await deleteStyle.mutateAsync(s.id);
                          setConfirmingId(null);
                          toast({
                            title: "Style deleted",
                            description: used
                              ? `${used} ${used === 1 ? "trade is" : "trades are"} now unassigned.`
                              : s.name,
                          });
                        }}
                        data-testid={`button-confirm-delete-style-${s.id}`}
                      >
                        Delete?
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmingId(s.id)}
                        data-testid={`button-delete-style-${s.id}`}
                        aria-label="Delete style"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const { data: tags, isLoading } = useMistakeTags();
  const { data: trades = [] } = useAllTrades();
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();
  /** A demon about to be deleted — it comes off every trade it was on, so it asks first. */
  const [deletingTagId, setDeletingTagId] = useState<number | null>(null);

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const tagNames = useMemo(
    () => Object.fromEntries((tags ?? []).map((t) => [t.id, t.name])) as Record<number, string>,
    [tags],
  );
  const costs = useMemo(
    () =>
      Object.fromEntries(
        mistakeCostLeaderboard(trades, tagNames).map((r) => [r.tagId, r]),
      ),
    [trades, tagNames],
  );

  async function add() {
    const name = newName.trim();
    if (!name) return;
    await createTag.mutateAsync({ name, sortOrder: (tags?.length ?? 0) });
    setNewName("");
    toast({ title: "Tag added", description: name });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your demons (named mistakes) and the risk guardrails that halt trading.
        </p>
      </div>

      <PublicModeCard />

      <ReviewDisciplineCard />

      <FreshStartCard />

      <StylesCard />

      <AccountFeesCard />

      <Card className="border-card-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold tracking-tight">Demons</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          The fixed nine come from Tom Dante's Demon Finder; add your own below. These are the
          one-tap chips shown when you close a trade. Prestige rises every 10 trades a demon is
          attached to — the more prestige, the more dangerous the habit.
        </p>

        <div className="mt-4 flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="New custom demon…"
            className="h-9 text-sm"
            data-testid="input-new-tag"
          />
          <Button
            onClick={add}
            disabled={!newName.trim() || createTag.isPending}
            className="h-9 shrink-0 gap-1 text-xs"
            data-testid="button-add-tag"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>

        <div className="mt-4 space-y-1.5">
          {isLoading ? (
            <>
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </>
          ) : (
            (tags ?? []).map((t) => {
              const c = costs[t.id];
              const { tier } = getPrestige(c?.trades ?? 0);
              const editing = editingId === t.id;
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-2 rounded-md border border-border/70 bg-secondary/25 px-3 py-2"
                  data-testid={`row-tag-${t.id}`}
                >
                  {editing ? (
                    <>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-8 text-sm"
                        data-testid={`input-edit-tag-${t.id}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-emerald-400"
                        onClick={async () => {
                          if (editName.trim())
                            await updateTag.mutateAsync({ id: t.id, name: editName.trim() });
                          setEditingId(null);
                        }}
                        data-testid={`button-save-tag-${t.id}`}
                        aria-label="Save tag"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        onClick={() => setEditingId(null)}
                        aria-label="Cancel"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm">{t.name}</span>
                      {c?.trades ? (
                        <Badge variant="outline" className={`shrink-0 text-[10px] ${tier.color}`}>
                          {tier.name}
                        </Badge>
                      ) : null}
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {c ? `-${fmtMoney(c.cost).replace("+", "")}` : "—"}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-muted-foreground"
                        onClick={() => {
                          setEditingId(t.id);
                          setEditName(t.name);
                        }}
                        data-testid={`button-edit-tag-${t.id}`}
                        aria-label="Edit tag"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {deletingTagId === t.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 shrink-0 px-2 text-[11px]"
                            disabled={deleteTag.isPending}
                            onClick={() =>
                              deleteTag.mutate(t.id, {
                                onSuccess: () => setDeletingTagId(null),
                                onError: (err: any) =>
                                  toast({ title: "Not deleted", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" }),
                              })
                            }
                            data-testid={`button-delete-tag-confirm-${t.id}`}
                          >
                            Delete — off every trade
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => setDeletingTagId(null)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeletingTagId(t.id)}
                          data-testid={`button-delete-tag-${t.id}`}
                          aria-label="Delete tag"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </Card>

      <GuardRailsCard />

      <Card className="border-card-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold tracking-tight">How the metrics work</h2>
        <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <li>
            <span className="text-foreground">Actual R</span> — realised move divided by your
            original risk (entry to initial stop).
          </li>
          <li>
            <span className="text-foreground">No-management R</span> — what the untouched plan
            would have paid: the full target if price hit target first, −1R if it hit the stop
            first.
          </li>
          <li>
            <span className="text-foreground">Δ management</span> — actual minus no-management.
            Negative means intervening cost you money.
          </li>
          <li>
            <span className="text-foreground">Capture</span> — actual R divided by MFE R: how much
            of the best available move you kept.
          </li>
          <li>
            Costs on the leaderboard split each trade's give-back evenly across the mistake tags
            attached to it.
          </li>
        </ul>
      </Card>

      <MarketsCard />

      <StorageCard />

      {/* Owner only; renders nothing for everyone else. */}
      <MembersCard />
    </div>
  );
}

/**
 * Where the space goes. Screenshots are the only thing in this app that can
 * meaningfully consume a 512 MB free-tier database, so their cost gets a
 * gauge — storage problems should be watched approaching, not discovered.
 */
/**
 * The switch that makes the journal showable.
 *
 * Kept at the top of Settings rather than buried with the appearance bits,
 * because it is the one setting here you turn on for a reason that is about to
 * happen — a screen share, a screenshot, somebody looking over your shoulder —
 * and having to hunt for it is having to hunt for it in front of them.
 */
/**
 * Starting over.
 *
 * The thing wanted after a bad run is a journal with no memory of it, and
 * the thing NOT wanted is to lose the record of what happened. A fresh start
 * is a date: from it on is the chapter every page shows; before it is kept
 * whole and reachable from the stats. See shared/chapters.ts for the rule.
 */
/**
 * How hard the journal pushes the review. On the user row, so the rule set
 * on the laptop holds on the phone; see shared/review-pressure.ts.
 */
function ReviewDisciplineCard() {
  const prefs = usePrefs();
  const set = useSetPrefs();
  const { toast } = useToast();
  const MODES: { id: ReviewMode; label: string; says: string }[] = [
    { id: "off", label: "Off", says: "No reminders. The Review tab is still there when you want it." },
    {
      id: "remind",
      label: "Remind",
      says: "A count on the Review tab and a banner on the journal whenever a finished day is not gone over — amber the day after, red once it is older.",
    },
    {
      id: "enforce",
      label: "Enforce",
      says: "As Remind, and once a day is past the grace your record and your stats stay shut until it is reviewed. Logging trades and open positions are never blocked, and you can look for an hour once a day. Only trades that finish after you switch this on can shut anything.",
    },
  ];
  const pick = async (id: ReviewMode) => {
    try {
      await set.mutateAsync({ reviewMode: id });
    } catch (err: any) {
      toast({ title: "Not saved", description: String(err?.message ?? err), variant: "destructive" });
    }
  };
  const current = MODES.find((m) => m.id === prefs.reviewMode) ?? MODES[1];
  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-review-discipline">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <BookOpen className="h-4 w-4" />
            Review discipline
          </h2>
          <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-muted-foreground">{current.says}</p>
          {prefs.reviewMode === "enforce" && prefs.reviewEnforcedSince && (
            <p className="mt-1 text-[10px] text-muted-foreground" data-testid="text-enforced-since">
              Enforced for trades finished since{" "}
              {new Date(prefs.reviewEnforcedSince).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}.
            </p>
          )}
        </div>
        <div className="inline-flex shrink-0 rounded-lg border border-border bg-secondary/30 p-0.5" role="radiogroup" aria-label="Review discipline">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={prefs.reviewMode === m.id}
              disabled={set.isPending}
              onClick={() => pick(m.id)}
              data-testid={`button-review-mode-${m.id}`}
              className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors ${
                prefs.reviewMode === m.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

/**
 * The person's own loss and tilt limits. Kept with their prefs, so the
 * daily guard, the tilt meter and the entry form read the same line on
 * every device; the defaults are what the journal shipped with.
 */
function GuardRailsCard() {
  const prefs = usePrefs();
  const set = useSetPrefs();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Record<keyof GuardRails, string> | null>(null);
  const rails = prefs.guard;
  const shown = (k: keyof GuardRails) => draft?.[k] ?? String(rails[k]);
  const begin = () =>
    setDraft(
      Object.fromEntries((Object.keys(DEFAULT_GUARDRAILS) as (keyof GuardRails)[]).map((k) => [k, String(rails[k])])) as Record<keyof GuardRails, string>,
    );
  const change = (k: keyof GuardRails, v: string) => {
    if (!draft) begin();
    setDraft((d) => ({ ...(d ?? (Object.fromEntries((Object.keys(DEFAULT_GUARDRAILS) as (keyof GuardRails)[]).map((kk) => [kk, String(rails[kk])])) as Record<keyof GuardRails, string>)), [k]: v }));
  };
  const parsed = (): GuardRails | string => {
    const out = { ...rails };
    for (const k of Object.keys(DEFAULT_GUARDRAILS) as (keyof GuardRails)[]) {
      const n = Number(String(shown(k)).replace(/[,$\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) return `${FIELDS.find((f) => f.key === k)?.label ?? k} needs a number.`;
      out[k] = k === "dailyLossAlert" || k === "dailyLossStop" ? n : Math.round(n);
    }
    const problem = guardRailsProblem(out);
    if (problem) return problem;
    if (out.lossStreakLimit < 1) return "The streak limit has to be at least one loss.";
    return out;
  };
  const result = draft ? parsed() : null;
  const problem = typeof result === "string" ? result : null;
  const dirty = draft != null && (Object.keys(DEFAULT_GUARDRAILS) as (keyof GuardRails)[]).some((k) => shown(k) !== String(rails[k]));
  const save = async (next: GuardRails) => {
    try {
      await set.mutateAsync({ guard: next });
      setDraft(null);
      toast({ title: "Guard rails saved", description: `Day stops at ${fmtMoney(-next.dailyLossStop)}, ${next.lossStreakLimit} losses in a row halt it.` });
    } catch (err: any) {
      toast({ title: "Not saved", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 200), variant: "destructive" });
    }
  };
  const FIELDS: { key: keyof GuardRails; label: string; unit: string; says: string }[] = [
    { key: "dailyLossAlert", label: "Daily warning", unit: "$", says: "down on the day: the guard turns amber" },
    { key: "dailyLossStop", label: "Daily hard stop", unit: "$", says: "down on the day: the day is over, the meter locks until midnight" },
    { key: "lossStreakLimit", label: "Losses in a row", unit: "trades", says: "halts the day and lights a segment on the meter" },
    { key: "cooldownSeconds", label: "Cooldown", unit: "s", says: "the forced break after that streak" },
    { key: "walkMinutes", label: "Walk", unit: "min", says: "how long the meter's lock holds past the last sign" },
    { key: "reentryMinutes", label: "Re-entry window", unit: "min", says: "back into a symbol this soon after losing on it is flagged" },
  ];
  const isDefault = (Object.keys(DEFAULT_GUARDRAILS) as (keyof GuardRails)[]).every((k) => rails[k] === DEFAULT_GUARDRAILS[k]);
  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-guard-rails">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <ShieldAlert className="h-4 w-4" />
            Risk guard rails
          </h2>
          <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-muted-foreground">
            Your limits, read off real closed trades: the daily guard, the tilt meter and the entry form all hold this line. Yours alone — every
            account signed in sets its own.
          </p>
        </div>
        {!isDefault && !draft && (
          <Button size="sm" variant="ghost" className="h-7 text-[11px] text-muted-foreground" onClick={() => void save(DEFAULT_GUARDRAILS)} disabled={set.isPending} data-testid="button-guard-defaults">
            Back to defaults
          </Button>
        )}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="block min-w-0 space-y-1" title={f.says}>
            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">{f.label}</span>
            <span className="flex h-9 items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-2.5 focus-within:border-primary/60">
              {f.unit === "$" && <span className="text-[11px] text-muted-foreground">$</span>}
              <input
                value={shown(f.key)}
                onChange={(e) => change(f.key, e.target.value)}
                inputMode="decimal"
                className="min-w-0 flex-1 bg-transparent font-mono text-sm tabular-nums outline-none"
                data-testid={`input-guard-${f.key}`}
              />
              {f.unit !== "$" && <span className="shrink-0 text-[11px] text-muted-foreground">{f.unit}</span>}
            </span>
            <span className="block text-[10px] leading-snug text-muted-foreground/80">{f.says}</span>
          </label>
        ))}
      </div>
      {draft && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-8 text-xs" disabled={!dirty || !!problem || set.isPending} onClick={() => typeof result === "object" && result && void save(result)} data-testid="button-guard-save">
            {set.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save guard rails
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" onClick={() => setDraft(null)} data-testid="button-guard-cancel">
            Cancel
          </Button>
          {problem && <span className="text-[11px] text-amber-500" data-testid="text-guard-problem">{problem}</span>}
        </div>
      )}
    </Card>
  );
}

function FreshStartCard() {
  const { spans, current } = useChapters();
  const { data: all = [] } = useAllTrades();
  const start = useStartChapter();
  const remove = useDeleteChapter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(localNow);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [undoing, setUndoing] = useState(false);
  const counts = useMemo(
    () => new Map(spans.map((s) => [s.id, all.filter((t) => inSpan(t, s)).length])),
    [spans, all],
  );

  async function begin() {
    try {
      await start.mutateAsync({ startedAt: toIso(when), name: name.trim() || null, note: note.trim() || null });
      setOpen(false);
      setName("");
      setNote("");
      toast({
        title: "Fresh start",
        description: "The journal begins again from here. Everything before it is kept, and is in Stats under its own chapter.",
      });
    } catch (err: any) {
      toast({ title: "Not started", description: String(err?.message ?? err), variant: "destructive" });
    }
  }

  async function undo() {
    if (!current) return;
    await remove.mutateAsync(current.id);
    setUndoing(false);
    toast({ title: "Fresh start undone", description: "The two chapters are one again. Nothing was deleted either way." });
  }

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-fresh-start">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <RotateCcw className="h-4 w-4" />
            Fresh start
          </h2>
          <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-muted-foreground">
            Start the journal over from a moment you choose. Nothing is deleted or changed: every trade
            before it stays stored, is left out of every page by default, and is one switch away in Stats
            — on its own, or alongside everything since. A position still open comes with you.
          </p>
        </div>
        {!open && (
          <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 text-[11px]" onClick={() => { setWhen(localNow()); setOpen(true); }} data-testid="button-fresh-start">
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            Start over…
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-2 rounded-md border border-border/70 bg-secondary/20 p-3" data-testid="form-fresh-start">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-[11px] text-muted-foreground">
              <span>From</span>
              <DateTime24 value={when} onChange={setWhen} testId="input-fresh-start-when" />
            </label>
            <label className="space-y-1 text-[11px] text-muted-foreground">
              <span>Name (optional)</span>
              <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={`Chapter ${spans.length + 1}`} className="h-8 text-xs" data-testid="input-fresh-start-name" />
            </label>
          </div>
          <label className="block space-y-1 text-[11px] text-muted-foreground">
            <span>What you are leaving behind, and what changes (optional)</span>
            <Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} rows={2} className="text-xs" data-testid="input-fresh-start-note" />
          </label>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" className="h-8 text-[11px]" onClick={begin} disabled={start.isPending} data-testid="button-fresh-start-confirm">
              <Check className="mr-1 h-3.5 w-3.5" />
              Start the new chapter
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-8 text-[11px]" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {spans.length > 0 && (
        <ul className="mt-3 divide-y divide-border/50 rounded-md border border-card-border" data-testid="list-chapters">
          {[...spans].reverse().map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs" data-testid={`chapter-${s.id}`}>
              <BookOpen className={`h-3.5 w-3.5 ${s.current ? "text-sky-400" : "text-muted-foreground"}`} />
              <span className="font-semibold">{spanLabel(s)}</span>
              <span className="text-muted-foreground">{spanRange(s)}</span>
              <span className="font-mono text-muted-foreground">
                {counts.get(s.id) ?? 0} trade{(counts.get(s.id) ?? 0) === 1 ? "" : "s"}
              </span>
              {s.current && <Badge variant="outline" className="text-[10px] text-sky-400 border-sky-500/40">now</Badge>}
              {s.current && !undoing && (
                <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 text-[11px] text-muted-foreground" onClick={() => setUndoing(true)} data-testid="button-undo-fresh-start">
                  Undo
                </Button>
              )}
              {s.current && undoing && (
                <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                  Merge back into the chapter before? Nothing is deleted.
                  <Button type="button" size="sm" variant="destructive" className="h-7 text-[11px]" onClick={undo} disabled={remove.isPending} data-testid="button-undo-fresh-start-confirm">
                    Undo
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setUndoing(false)}>
                    Keep
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PublicModeCard() {
  const { isPublic, setPublic } = usePublicMode();
  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-public-mode">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            {isPublic ? <EyeOff className="h-4 w-4 text-amber-500" /> : <Eye className="h-4 w-4" />}
            Public mode
          </h2>
          <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-muted-foreground">
            Withholds every figure in your account's own currency — P&amp;L, fees, 1R, position
            size in USD, the balances and the equity axis — and leaves the rest of the journal
            exactly as it is. R, the verdicts, the win rate, the expectancy and the shape of the
            curve all still read, because none of them say how much money you have.
          </p>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            Nothing is changed or deleted, and the statistics stay in R while it is on. Turn it
            off and the same numbers are where they were.
          </p>
        </div>
        <Button
          type="button"
          variant={isPublic ? "default" : "outline"}
          size="sm"
          onClick={() => setPublic(!isPublic)}
          aria-pressed={isPublic}
          className="h-8 shrink-0 text-[11px]"
          data-testid="button-public-mode"
        >
          {isPublic ? "On — amounts hidden" : "Off"}
        </Button>
      </div>
    </Card>
  );
}

function StorageCard() {
  const { data } = useStorageUsage();
  if (!data) return null;
  const mb = data.bytes / (1024 * 1024);
  const budgetMb = 512; // Neon free tier
  const pct = Math.min(100, (mb / budgetMb) * 100);
  const avgKb = data.images ? data.bytes / data.images / 1024 : 0;
  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-storage">
      <h2 className="text-sm font-semibold tracking-tight">Screenshot storage</h2>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Images are recompressed to review quality before saving (~40–90 KB each) and load only
        when a trade's detail is opened.
      </p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary/60">
        <div
          className={`h-full rounded-full ${pct > 80 ? "bg-red-500" : pct > 50 ? "bg-amber-500" : "bg-primary"}`}
          style={{ width: `${Math.max(pct, 0.5)}%` }}
        />
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground" data-testid="text-storage">
        {data.images} {data.images === 1 ? "image" : "images"} · {mb.toFixed(1)} MB of ~
        {budgetMb} MB free tier{data.images > 0 && ` · ~${Math.round(avgKb)} KB avg`}
      </p>
    </Card>
  );
}
