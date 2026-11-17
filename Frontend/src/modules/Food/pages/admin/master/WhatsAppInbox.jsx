import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Loader2, Search, RefreshCw, Send, Check, CheckCheck, AlertCircle, Clock, MessageCircle, Settings } from "lucide-react"
import { whatsappInboxAPI } from "@food/api"

/**
 * Master > WhatsApp: messages customers send to the business WhatsApp number,
 * and the delivery receipts for what the platform sends (invoices, replies).
 *
 * Everything arrives through Meta's webhook (core/whatsapp on the server). A
 * free-form reply is only allowed within 24 hours of the customer's last
 * message; that is Meta's rule, so the box closes outside it.
 */

const POLL_MS = 15000
const errText = (err, fallback) => err?.response?.data?.message || err?.message || fallback
const dataOf = (res) => res?.data?.data ?? res?.data

const fmtPhone = (p = "") => (p.length === 12 && p.startsWith("91") ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : `+${p}`)
const fmtTime = (d) => {
  if (!d) return ""
  const t = new Date(d)
  const today = new Date().toDateString() === t.toDateString()
  return today
    ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : t.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

function Receipt({ status, error }) {
  if (status === "read") return <CheckCheck className="h-3.5 w-3.5 text-sky-500" aria-label="Read" />
  if (status === "delivered") return <CheckCheck className="h-3.5 w-3.5 text-neutral-400" aria-label="Delivered" />
  if (status === "sent") return <Check className="h-3.5 w-3.5 text-neutral-400" aria-label="Sent" />
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-0.5 text-red-600" title={error || "Not delivered"}>
        <AlertCircle className="h-3.5 w-3.5" /> Failed
      </span>
    )
  return <Clock className="h-3.5 w-3.5 text-neutral-400" aria-label="Sending" />
}

const SENDER = { "food-invoice": "Food invoice", "taxi-invoice": "Taxi invoice" }
const senderLabel = (s = "") => SENDER[s] || (s.startsWith("admin:") ? "Admin reply" : "")

function StatusStrip({ status }) {
  if (!status) return null
  const problems = []
  if (!status.sending) problems.push("the access token and phone number id are not saved, so nothing can be sent")
  if (!status.appSecretSet) problems.push("the app secret is not saved, so Meta's messages are refused")
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-4 py-2.5 text-sm ${problems.length ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900"}`}
    >
      {problems.length ? (
        <span>
          Not fully connected: {problems.join("; ")}.{" "}
          <Link to="/admin/master/settings/integrations" className="inline-flex items-center gap-1 font-semibold underline">
            <Settings className="h-3.5 w-3.5" /> Open WhatsApp settings
          </Link>
        </span>
      ) : (
        <span className="font-medium">Connected to WhatsApp</span>
      )}
      <span className="text-xs opacity-80">
        Last message received: {status.lastMessageAt ? fmtTime(status.lastMessageAt) : "none yet"} · Last receipt:{" "}
        {status.lastReceiptAt ? fmtTime(status.lastReceiptAt) : "none yet"}
      </span>
    </div>
  )
}

export default function WhatsAppInbox() {
  const [status, setStatus] = useState(null)
  const [list, setList] = useState([])
  const [loadingList, setLoadingList] = useState(true)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState("")
  const [thread, setThread] = useState(null)
  const [loadingThread, setLoadingThread] = useState(false)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const bottomRef = useRef(null)

  const loadList = useCallback(async (q = search) => {
    try {
      const [s, c] = await Promise.all([whatsappInboxAPI.status(), whatsappInboxAPI.conversations({ search: q || undefined })])
      setStatus(dataOf(s))
      setList(dataOf(c) || [])
    } catch (err) {
      toast.error(errText(err, "Could not load WhatsApp messages"))
    } finally {
      setLoadingList(false)
    }
  }, [search])

  const loadThread = useCallback(async (phone, { quiet = false } = {}) => {
    if (!phone) return
    if (!quiet) setLoadingThread(true)
    try {
      setThread(dataOf(await whatsappInboxAPI.conversation(phone)))
    } catch (err) {
      if (!quiet) toast.error(errText(err, "Could not open the conversation"))
    } finally {
      setLoadingThread(false)
    }
  }, [])

  useEffect(() => {
    loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep both panes fresh while the page is open.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return
      loadList()
      if (selected) loadThread(selected, { quiet: true })
    }, POLL_MS)
    return () => clearInterval(t)
  }, [loadList, loadThread, selected])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [thread?.messages?.length])

  const open = (phone) => {
    setSelected(phone)
    setDraft("")
    loadThread(phone)
    setList((rows) => rows.map((r) => (r.phone === phone ? { ...r, unread: 0 } : r)))
  }

  const send = async (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !selected) return
    setSending(true)
    try {
      await whatsappInboxAPI.reply(selected, text)
      setDraft("")
      toast.success("Sent")
      await loadThread(selected, { quiet: true })
      loadList()
    } catch (err) {
      toast.error(errText(err, "Could not send"))
    } finally {
      setSending(false)
    }
  }

  const current = list.find((c) => c.phone === selected)

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">WhatsApp</h1>
          <p className="text-sm text-neutral-500">Messages customers send to the business number, and delivery receipts for ours.</p>
        </div>
        <button
          type="button"
          onClick={() => { loadList(); if (selected) loadThread(selected, { quiet: true }) }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <StatusStrip status={status} />

      <div className="grid min-h-[60vh] overflow-hidden rounded-xl border border-neutral-200 bg-white md:grid-cols-[320px_1fr]">
        {/* Conversations */}
        <aside className={`flex min-h-0 flex-col border-neutral-200 md:border-r ${selected ? "hidden md:flex" : "flex"}`}>
          <form
            className="border-b border-neutral-100 p-3"
            onSubmit={(e) => { e.preventDefault(); setLoadingList(true); loadList(search) }}
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-neutral-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or number"
                className="w-full rounded-lg border border-neutral-300 py-2 pl-8 pr-3 text-sm focus:border-neutral-900 focus:outline-none"
              />
            </div>
          </form>
          <div className="max-h-[65vh] flex-1 overflow-y-auto">
            {loadingList ? (
              <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-neutral-400" /></div>
            ) : list.length === 0 ? (
              <div className="p-8 text-center text-sm text-neutral-500">
                <MessageCircle className="mx-auto mb-2 h-6 w-6 text-neutral-300" />
                No WhatsApp messages yet. They appear here as soon as Meta delivers them.
              </div>
            ) : (
              list.map((c) => (
                <button
                  key={c.phone}
                  type="button"
                  onClick={() => open(c.phone)}
                  className={`flex w-full items-start gap-3 border-b border-neutral-100 px-3 py-3 text-left hover:bg-neutral-50 ${selected === c.phone ? "bg-emerald-50/60" : ""}`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-800">
                    {(c.contactName || "#").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-neutral-900">{c.contactName || fmtPhone(c.phone)}</span>
                      <span className="shrink-0 text-[11px] text-neutral-400">{fmtTime(c.lastAt)}</span>
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1 truncate text-xs text-neutral-500">
                        {c.lastDirection === "out" && <Receipt status={c.lastStatus} />}
                        <span className="truncate">{c.lastText}</span>
                      </span>
                      {c.unread > 0 && (
                        <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 text-[11px] font-semibold text-white">{c.unread}</span>
                      )}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Thread */}
        <section className={`min-h-0 flex-col ${selected ? "flex" : "hidden md:flex"}`}>
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-neutral-500">Choose a conversation</div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-neutral-100 px-4 py-3">
                <button type="button" className="text-sm text-neutral-500 md:hidden" onClick={() => setSelected("")}>← Back</button>
                <div className="min-w-0">
                  <div className="truncate font-medium text-neutral-900">{thread?.contactName || current?.contactName || fmtPhone(selected)}</div>
                  <a href={`tel:+${selected}`} className="text-xs text-neutral-500 hover:underline">{fmtPhone(selected)}</a>
                </div>
              </header>
              <div className="max-h-[55vh] flex-1 space-y-2 overflow-y-auto bg-[#efeae2] px-4 py-4">
                {loadingThread && !thread ? (
                  <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-neutral-500" /></div>
                ) : (
                  (thread?.messages || []).map((m) => (
                    <div key={m.wamid} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm ${m.direction === "out" ? "bg-[#d9fdd3] text-neutral-900" : "bg-white text-neutral-900"}`}
                      >
                        {senderLabel(m.sentBy) && <div className="mb-0.5 text-[11px] font-semibold text-emerald-700">{senderLabel(m.sentBy)}</div>}
                        <div className="whitespace-pre-wrap break-words">
                          {m.text || <span className="italic text-neutral-500">[{m.type}]</span>}
                        </div>
                        {m.text && m.type !== "text" && m.direction === "in" && (
                          <div className="mt-0.5 text-[11px] italic text-neutral-500">{m.type}</div>
                        )}
                        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-neutral-500">
                          {fmtTime(m.sentAt || m.createdAt)}
                          {m.direction === "out" && <Receipt status={m.status} error={m.error} />}
                        </div>
                        {m.status === "failed" && m.error && <div className="mt-1 text-[11px] text-red-600">{m.error}</div>}
                      </div>
                    </div>
                  ))
                )}
                <div ref={bottomRef} />
              </div>
              {thread?.canReply ? (
                <form onSubmit={send} className="flex items-end gap-2 border-t border-neutral-100 p-3">
                  <textarea
                    rows={2}
                    value={draft}
                    maxLength={4096}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) send(e) }}
                    placeholder="Type a reply. Enter sends, Shift+Enter for a new line"
                    className="min-w-0 flex-1 resize-none rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={sending || !draft.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-neutral-200 disabled:text-neutral-500"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
                  </button>
                </form>
              ) : (
                <p className="border-t border-neutral-100 px-4 py-3 text-xs text-neutral-500">
                  Replies are closed: WhatsApp allows a free-form reply only within 24 hours of the customer's last message.
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
