import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import {
  Loader2, RefreshCw, Send, CheckCircle2, AlertTriangle, Megaphone, FileText, Users, Bell,
  Activity, Upload, X, MessageCircle, Settings,
} from "lucide-react"
import { whatsappMarketingAPI as api } from "@food/api"

/**
 * Master > WhatsApp Marketing: campaigns, templates, opt-in / opt-out and
 * automatic order alerts on the business WhatsApp number, without opening
 * Meta's dashboard. Customer replies land in Master > WhatsApp Inbox.
 */

const errText = (err, fallback) => err?.response?.data?.message || err?.message || fallback
const dataOf = (res) => res?.data?.data ?? res?.data
const fmtPhone = (p = "") => (p.length === 12 && p.startsWith("91") ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : `+${p}`)
const fmtDate = (d) => (d ? new Date(d).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "")

const TABS = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "campaigns", label: "Campaigns", icon: Megaphone },
  { key: "templates", label: "Templates", icon: FileText },
  { key: "contacts", label: "Contacts", icon: Users },
  { key: "alerts", label: "Order alerts", icon: Bell },
]

const input = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
const btn = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
const btnDark = `${btn} bg-neutral-900 text-white hover:bg-neutral-800`
const btnLight = `${btn} border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50`
const card = "rounded-xl border border-neutral-200 bg-white p-5"

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-neutral-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  )
}

function Pill({ tone = "neutral", children }) {
  const tones = {
    neutral: "bg-neutral-100 text-neutral-700",
    green: "bg-emerald-50 text-emerald-800",
    amber: "bg-amber-50 text-amber-800",
    red: "bg-red-50 text-red-700",
    blue: "bg-sky-50 text-sky-800",
  }
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
}

const templateTone = (s) => (s === "APPROVED" ? "green" : s === "REJECTED" ? "red" : "amber")

/* ------------------------------------------------------------ overview -- */

function Overview({ status, reload, report }) {
  if (!status) return <Spinner />
  const m = status.meta
  const rows = [
    ["Business number", m ? `${m.displayPhoneNumber} (${m.verifiedName})` : "-"],
    ["Number status", m?.status || status.metaError || "-"],
    ["Quality rating", m?.qualityRating || "-"],
    ["Daily limit", m ? (m.dailyLimit ? `${m.dailyLimit} customers / 24 hours (${m.messagingLimitTier})` : "Unlimited") : "-"],
    ["Phone number ID", status.phoneNumberId || "-"],
    ["WhatsApp business account ID", status.businessAccountId || "-"],
    ["Webhook URL", `${window.location.origin}${status.webhookUrl}`],
    ["Last message received", status.lastMessageAt ? fmtDate(status.lastMessageAt) : "None yet"],
    ["Last delivery receipt", status.lastReceiptAt ? fmtDate(status.lastReceiptAt) : "None yet"],
  ]
  const problems = []
  if (!status.connected) problems.push("The access token and phone number ID are not saved, so nothing can be sent.")
  if (status.metaError && status.connected) problems.push(`Meta: ${status.metaError}`)
  if (!status.appSecretSet) problems.push("The app secret is not saved, so Meta's incoming messages and delivery receipts are refused. Add it in WhatsApp settings (Meta > App settings > Basic > App secret).")
  if (!status.verifyTokenSet) problems.push("The webhook verify token is not set.")
  const r = report?.report || {}
  return (
    <div className="space-y-4">
      <div className={`${card} ${problems.length ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
        <div className="flex items-start gap-3">
          {problems.length ? <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-700" /> : <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-700" />}
          <div className="flex-1 text-sm">
            <p className="font-semibold">{problems.length ? "Connected, with things to fix" : "WhatsApp is connected"}</p>
            {problems.map((p) => <p key={p} className="mt-1">{p}</p>)}
          </div>
          <div className="flex gap-2">
            <Link to="/admin/master/settings/integrations" className={btnLight}><Settings className="h-4 w-4" /> Settings</Link>
            <button type="button" onClick={reload} className={btnLight}><RefreshCw className="h-4 w-4" /> Check</button>
          </div>
        </div>
      </div>
      <div className={card}>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs font-semibold text-neutral-500">{k}</dt>
              <dd className="break-all text-sm text-neutral-900">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className={card}>
        <h3 className="mb-3 text-sm font-semibold">Last 30 days</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[["campaign", "Campaign messages"], ["order", "Order alerts"], ["other", "Other (invoices, replies, tests)"]].map(([k, label]) => {
            const x = r[k] || { total: 0, delivered: 0, read: 0, failed: 0 }
            return (
              <div key={k} className="rounded-lg bg-neutral-50 p-3 text-sm">
                <p className="text-xs font-semibold text-neutral-500">{label}</p>
                <p className="mt-1 text-xl font-semibold">{x.total}</p>
                <p className="text-xs text-neutral-600">{x.delivered + x.read} delivered · {x.read} read · {x.failed} failed</p>
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          {report?.inbound || 0} messages received from customers.{" "}
          <Link to="/admin/master/whatsapp" className="font-semibold underline">Open the WhatsApp inbox</Link>
        </p>
      </div>
    </div>
  )
}

/* ---------------------------------------------------- template filling -- */

function TemplateFields({ template, values, setValues, media, setMedia, placeholders }) {
  const v = template?.variables
  const [uploading, setUploading] = useState(false)
  if (!v) return null
  const set = (part, key, value) => setValues((prev) => ({ ...prev, [part]: { ...(prev[part] || {}), [key]: value } }))
  const mediaKind = ["IMAGE", "VIDEO", "DOCUMENT"].includes(v.headerFormat) ? v.headerFormat.toLowerCase() : ""
  const accept = mediaKind === "image" ? "image/jpeg,image/png" : mediaKind === "video" ? "video/mp4" : "application/pdf"

  const onFile = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const r = dataOf(await api.uploadMedia(file))
      setMedia({ mediaId: r.mediaId, link: "", filename: r.filename })
      toast.success(`${file.name} uploaded`)
    } catch (err) {
      toast.error(errText(err, "Upload failed"))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-[#e7f8ee] p-3 text-sm text-neutral-800">
        {v.headerText ? <p className="font-semibold">{v.headerText}</p> : null}
        {mediaKind ? <p className="text-xs text-neutral-500">[{mediaKind} header]</p> : null}
        <p className="whitespace-pre-wrap">{v.bodyText}</p>
        {v.footerText ? <p className="mt-1 text-xs text-neutral-500">{v.footerText}</p> : null}
        {v.buttonLabels?.length ? <p className="mt-2 text-xs text-sky-700">{v.buttonLabels.join(" · ")}</p> : null}
      </div>
      {mediaKind ? (
        <Field label={`Header ${mediaKind}`} hint={`Upload the ${mediaKind} every customer sees (Meta keeps it 30 days), or paste a public https link.`}>
          <div className="flex flex-wrap items-center gap-2">
            <label className={`${btnLight} cursor-pointer`}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload
              <input type="file" accept={accept} className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <input className={`${input} max-w-md flex-1`} placeholder="or https://..." value={media.link || ""} onChange={(e) => setMedia({ mediaId: "", link: e.target.value, filename: "" })} />
            {media.mediaId ? <Pill tone="green">Uploaded: {media.filename || media.mediaId}</Pill> : null}
          </div>
        </Field>
      ) : null}
      {v.header.map((k) => (
        <Field key={`h${k}`} label={`Header {{${k}}}`}>
          <input className={input} value={values.header?.[k] || ""} onChange={(e) => set("header", k, e.target.value)} />
        </Field>
      ))}
      {v.body.map((k) => (
        <Field key={`b${k}`} label={`Text {{${k}}}`} hint={`You can use ${placeholders.map((p) => `{${p}}`).join(" ")}`}>
          <input className={input} value={values.body?.[k] || ""} onChange={(e) => set("body", k, e.target.value)} />
        </Field>
      ))}
      {v.buttons.map((b) => (
        <Field key={`u${b.index}`} label={`Button "${b.label}" link ending`} hint={b.url}>
          <input className={input} value={values.buttons?.[b.index] || ""} onChange={(e) => set("buttons", b.index, e.target.value)} />
        </Field>
      ))}
    </div>
  )
}

/* ----------------------------------------------------------- campaigns -- */

const AUDIENCES = [
  { value: "all", label: "All customers" },
  { value: "ordered", label: "Ordered food / grocery in the last N days" },
  { value: "not_ordered", label: "Never ordered food / grocery" },
  { value: "joined", label: "Joined in the last N days" },
  { value: "phones", label: "Specific numbers" },
]

const campaignTone = (s) => (s === "done" ? "green" : s === "sending" ? "blue" : s === "paused_limit" ? "amber" : s === "cancelled" ? "red" : "neutral")
const campaignLabel = { draft: "Draft", sending: "Sending", paused_limit: "Waiting for daily limit", done: "Done", cancelled: "Stopped" }

function NewCampaign({ templates, onDone, onClose }) {
  const approved = templates.filter((t) => t.status === "APPROVED")
  const [name, setName] = useState("")
  const [tplKey, setTplKey] = useState("")
  const [values, setValues] = useState({})
  const [media, setMedia] = useState({})
  const [audience, setAudience] = useState({ type: "all", days: 30, city: "", phones: "", onlyOptedIn: false })
  const [preview, setPreview] = useState(null)
  const [testPhone, setTestPhone] = useState("")
  const [busy, setBusy] = useState("")
  const template = approved.find((t) => `${t.name}|${t.language}` === tplKey)

  useEffect(() => { setValues({}); setMedia({}) }, [tplKey])
  useEffect(() => {
    const id = setTimeout(async () => {
      try {
        setPreview(dataOf(await api.previewAudience(audience)))
      } catch (err) {
        setPreview({ error: errText(err, "Could not count customers") })
      }
    }, 400)
    return () => clearTimeout(id)
  }, [audience])

  const body = () => ({
    name,
    templateName: template?.name,
    language: template?.language,
    variables: values,
    headerMedia: media,
    audience,
  })

  const sendTest = async () => {
    setBusy("test")
    try {
      await api.sendTest({ ...body(), phone: testPhone })
      toast.success("Test sent. Check that phone's WhatsApp.")
    } catch (err) {
      toast.error(errText(err, "Test failed"))
    } finally {
      setBusy("")
    }
  }

  const start = async () => {
    if (!window.confirm(`Send "${template?.name}" to ${preview?.count ?? "these"} customers now?`)) return
    setBusy("start")
    try {
      await api.createCampaign(body())
      toast.success("Campaign started")
      onDone()
    } catch (err) {
      toast.error(errText(err, "Could not start the campaign"))
    } finally {
      setBusy("")
    }
  }

  const setA = (k, v) => setAudience((a) => ({ ...a, [k]: v }))

  return (
    <div className={`${card} space-y-5`}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">New campaign</h3>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-neutral-100" aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Campaign name"><input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Diwali offer, Palampur" /></Field>
        <Field label="Approved template" hint={approved.length ? "" : "No approved templates yet: create one in the Templates tab."}>
          <select className={input} value={tplKey} onChange={(e) => setTplKey(e.target.value)}>
            <option value="">Choose…</option>
            {approved.map((t) => <option key={t.id} value={`${t.name}|${t.language}`}>{t.name} ({t.language}, {t.category.toLowerCase()})</option>)}
          </select>
        </Field>
      </div>
      {template ? <TemplateFields template={template} values={values} setValues={setValues} media={media} setMedia={setMedia} placeholders={["name", "phone"]} /> : null}

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
        <p className="text-sm font-semibold">Customers</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Who">
            <select className={input} value={audience.type} onChange={(e) => setA("type", e.target.value)}>
              {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </Field>
          {["ordered", "joined"].includes(audience.type) ? (
            <Field label="Days"><input type="number" min="1" className={input} value={audience.days} onChange={(e) => setA("days", e.target.value)} /></Field>
          ) : null}
          {audience.type !== "phones" ? (
            <Field label="City (optional)" hint="Matches any saved address"><input className={input} value={audience.city} onChange={(e) => setA("city", e.target.value)} placeholder="Palampur" /></Field>
          ) : null}
        </div>
        {audience.type === "phones" ? (
          <Field label="Phone numbers" hint="One per line or comma separated; 10-digit numbers get +91">
            <textarea rows={4} className={input} value={audience.phones} onChange={(e) => setA("phones", e.target.value)} />
          </Field>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={audience.onlyOptedIn} onChange={(e) => setA("onlyOptedIn", e.target.checked)} />
          Only customers who opted in (replied START or were marked opted in)
        </label>
        <p className="text-sm text-neutral-700">
          {preview?.error ? <span className="text-red-600">{preview.error}</span>
            : preview ? <>
              <b>{preview.count}</b> customers will get it.
              {preview.skippedOptedOut ? ` ${preview.skippedOptedOut} opted out and are left out.` : ""}
            </> : "Counting…"}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg bg-neutral-50 p-4">
        <Field label="Send a test first"><input className={`${input} w-56`} value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="98765 43210" /></Field>
        <button type="button" className={btnLight} disabled={!template || !testPhone || busy} onClick={sendTest}>
          {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send test
        </button>
        <div className="flex-1" />
        <button type="button" className={btnDark} disabled={!template || !name || !preview?.count || busy} onClick={start}>
          {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />} Send to {preview?.count ?? 0} customers
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        Meta lets this number start conversations with a limited number of customers a day. A bigger campaign pauses at the limit and continues by itself.
        Customers can reply STOP to stop offers.
      </p>
    </div>
  )
}

function CampaignDetail({ id, onClose }) {
  const [data, setData] = useState(null)
  const load = useCallback(async () => {
    try { setData(dataOf(await api.campaign(id))) } catch (err) { toast.error(errText(err, "Could not load")) }
  }, [id])
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])
  if (!data) return <div className={card}><Spinner /></div>
  const c = data.campaign
  const s = c.stats || {}
  return (
    <div className={`${card} space-y-4`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{c.name}</h3>
          <p className="text-xs text-neutral-500">{c.template.name} ({c.template.language}) · started {fmtDate(c.startedAt)}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-neutral-100" aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[["Customers", c.totalRecipients], ["Sent", s.sent], ["Delivered", s.deliveredTotal], ["Read", s.read], ["Failed", s.failedTotal]].map(([k, n]) => (
          <div key={k} className="rounded-lg bg-neutral-50 p-3"><p className="text-xs text-neutral-500">{k}</p><p className="text-lg font-semibold">{n || 0}</p></div>
        ))}
      </div>
      {c.lastError ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{c.lastError}</p> : null}
      {data.failureReasons.length ? (
        <div>
          <p className="mb-1 text-sm font-semibold">Why messages failed</p>
          <ul className="space-y-1 text-sm">{data.failureReasons.map((f) => <li key={f.reason}><b>{f.count}</b> · {f.reason}</li>)}</ul>
        </div>
      ) : null}
      <div>
        <p className="mb-1 text-sm font-semibold">Replies since it went out ({data.replies.length})</p>
        {data.replies.length ? (
          <ul className="max-h-60 divide-y overflow-auto rounded-lg border text-sm">
            {data.replies.map((r) => (
              <li key={r._id} className="flex justify-between gap-3 px-3 py-2">
                <span><b>{r.contactName || fmtPhone(r.phone)}</b> {r.text || `[${r.type}]`}</span>
                <span className="whitespace-nowrap text-xs text-neutral-500">{fmtDate(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-neutral-500">None yet.</p>}
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">Customers ({data.recipients.length})</summary>
        <div className="mt-2 max-h-80 overflow-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-neutral-50 text-xs text-neutral-500"><tr><th className="px-3 py-2">Customer</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Error</th></tr></thead>
            <tbody>
              {data.recipients.map((r) => (
                <tr key={r.phone} className="border-t">
                  <td className="px-3 py-1.5">{r.name || "-"} <span className="text-neutral-500">{fmtPhone(r.phone)}</span></td>
                  <td className="px-3 py-1.5">{r.status || r.state}</td>
                  <td className="px-3 py-1.5 text-xs text-red-600">{r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function Campaigns({ templates }) {
  const [list, setList] = useState(null)
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState("")
  const load = useCallback(async () => {
    try { setList(dataOf(await api.campaigns({ limit: 50 }))) } catch (err) { toast.error(errText(err, "Could not load campaigns")) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])

  const stop = async (id) => {
    if (!window.confirm("Stop this campaign? Customers not reached yet will not get it.")) return
    try { await api.cancelCampaign(id); toast.success("Stopped"); load() } catch (err) { toast.error(errText(err, "Could not stop")) }
  }

  return (
    <div className="space-y-4">
      {creating ? (
        <NewCampaign templates={templates} onClose={() => setCreating(false)} onDone={() => { setCreating(false); load() }} />
      ) : (
        <button type="button" className={btnDark} onClick={() => setCreating(true)}><Megaphone className="h-4 w-4" /> New campaign</button>
      )}
      {openId ? <CampaignDetail id={openId} onClose={() => setOpenId("")} /> : null}
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 text-xs text-neutral-500">
            <tr>{["Campaign", "Template", "Status", "Customers", "Delivered", "Read", "Failed", "Started", ""].map((h) => <th key={h} className="whitespace-nowrap px-4 py-3">{h}</th>)}</tr>
          </thead>
          <tbody>
            {!list ? <tr><td colSpan={9}><Spinner /></td></tr>
              : !list.campaigns.length ? <tr><td colSpan={9} className="px-4 py-8 text-center text-neutral-500">No campaigns yet.</td></tr>
                : list.campaigns.map((c) => (
                  <tr key={c._id} className="border-t hover:bg-neutral-50">
                    <td className="px-4 py-3 font-medium"><button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => setOpenId(c._id)}>{c.name}</button></td>
                    <td className="px-4 py-3">{c.template.name}</td>
                    <td className="px-4 py-3"><Pill tone={campaignTone(c.status)}>{campaignLabel[c.status] || c.status}</Pill></td>
                    <td className="px-4 py-3">{c.totalRecipients}</td>
                    <td className="px-4 py-3">{c.stats?.deliveredTotal || 0}</td>
                    <td className="px-4 py-3">{c.stats?.read || 0}</td>
                    <td className="px-4 py-3">{c.stats?.failedTotal || 0}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-neutral-500">{fmtDate(c.startedAt)}</td>
                    <td className="px-4 py-3">
                      {["sending", "paused_limit"].includes(c.status) ? <button type="button" className="text-xs font-semibold text-red-600 hover:underline" onClick={() => stop(c._id)}>Stop</button> : null}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- templates -- */

function NewTemplate({ onDone, onClose }) {
  const [f, setF] = useState({ name: "", category: "MARKETING", language: "en", headerText: "", body: "", footer: "", bodyExamples: [], buttons: [] })
  const [busy, setBusy] = useState(false)
  const vars = useMemo(() => [...new Set([...f.body.matchAll(/{{\s*(\d+)\s*}}/g)].map((m) => m[1]))], [f.body])
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }))
  const submit = async () => {
    setBusy(true)
    try {
      await api.createTemplate(f)
      toast.success("Submitted to Meta. Approval usually takes minutes to a few hours.")
      onDone()
    } catch (err) {
      toast.error(errText(err, "Meta refused the template"))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`${card} space-y-4`}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">New template</h3>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-neutral-100" aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Name" hint="lowercase_with_underscores"><input className={input} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="order_confirmed" /></Field>
        <Field label="Category" hint="Utility: order updates. Marketing: offers and promotions.">
          <select className={input} value={f.category} onChange={(e) => set("category", e.target.value)}>
            <option value="MARKETING">Marketing</option>
            <option value="UTILITY">Utility</option>
          </select>
        </Field>
        <Field label="Language">
          <select className={input} value={f.language} onChange={(e) => set("language", e.target.value)}>
            <option value="en">English</option>
            <option value="en_US">English (US)</option>
            <option value="hi">Hindi</option>
          </select>
        </Field>
      </div>
      <Field label="Header (optional)"><input className={input} maxLength={60} value={f.headerText} onChange={(e) => set("headerText", e.target.value)} /></Field>
      <Field label="Message" hint="Use {{1}}, {{2}}… for parts that change per customer, e.g. Hi {{1}}, your order {{2}} is on its way.">
        <textarea rows={5} className={input} maxLength={1024} value={f.body} onChange={(e) => set("body", e.target.value)} />
      </Field>
      {vars.length ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {vars.map((k, i) => (
            <Field key={k} label={`Example for {{${k}}}`} hint="Meta reviews with these">
              <input className={input} value={f.bodyExamples[i] || ""} onChange={(e) => { const ex = [...f.bodyExamples]; ex[i] = e.target.value; set("bodyExamples", ex) }} />
            </Field>
          ))}
        </div>
      ) : null}
      <Field label="Footer (optional)" hint="Marketing templates: Meta recommends 'Reply STOP to stop offers'"><input className={input} maxLength={60} value={f.footer} onChange={(e) => set("footer", e.target.value)} /></Field>
      <div className="space-y-2">
        <p className="text-xs font-semibold text-neutral-600">Buttons (optional)</p>
        {f.buttons.map((b, i) => (
          <div key={i} className="flex flex-wrap gap-2">
            <select className={`${input} w-40`} value={b.type} onChange={(e) => set("buttons", f.buttons.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
              <option value="QUICK_REPLY">Quick reply</option>
              <option value="URL">Link</option>
            </select>
            <input className={`${input} w-48`} placeholder="Button text" maxLength={25} value={b.text} onChange={(e) => set("buttons", f.buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            {b.type === "URL" ? <input className={`${input} flex-1`} placeholder="https://quickdropsindia.com" value={b.url || ""} onChange={(e) => set("buttons", f.buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} /> : null}
            <button type="button" className={btnLight} onClick={() => set("buttons", f.buttons.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
          </div>
        ))}
        {f.buttons.length < 3 ? <button type="button" className={btnLight} onClick={() => set("buttons", [...f.buttons, { type: "QUICK_REPLY", text: "" }])}>Add button</button> : null}
      </div>
      <button type="button" className={btnDark} disabled={busy || !f.name || !f.body} onClick={submit}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit for approval
      </button>
    </div>
  )
}

function Templates({ templates, reload, loading }) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {creating ? null : <button type="button" className={btnDark} onClick={() => setCreating(true)}><FileText className="h-4 w-4" /> New template</button>}
        <button type="button" className={btnLight} onClick={() => reload(true)} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh from Meta</button>
      </div>
      {creating ? <NewTemplate onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(true) }} /> : null}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {templates.map((t) => (
          <div key={t.id} className={card}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold">{t.name}</span>
              <Pill tone={templateTone(t.status)}>{t.status.toLowerCase()}</Pill>
              <Pill>{t.category.toLowerCase()}</Pill>
              <Pill>{t.language}</Pill>
            </div>
            {t.variables?.headerFormat && t.variables.headerFormat !== "TEXT" ? <p className="text-xs text-neutral-500">[{t.variables.headerFormat.toLowerCase()} header]</p> : null}
            {t.variables?.headerText ? <p className="text-sm font-semibold">{t.variables.headerText}</p> : null}
            <p className="whitespace-pre-wrap text-sm text-neutral-700">{t.variables?.bodyText}</p>
            {t.variables?.buttonLabels?.length ? <p className="mt-1 text-xs text-sky-700">{t.variables.buttonLabels.join(" · ")}</p> : null}
            {t.rejected_reason && t.rejected_reason !== "NONE" ? <p className="mt-2 text-xs text-red-600">Rejected: {t.rejected_reason}</p> : null}
          </div>
        ))}
        {!templates.length ? <p className="text-sm text-neutral-500">{loading ? "Loading…" : "No templates on the account yet."}</p> : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ contacts -- */

function Contacts() {
  const [filter, setFilter] = useState({ search: "", marketing: "" })
  const [data, setData] = useState(null)
  const [phone, setPhone] = useState("")
  const load = useCallback(async () => {
    try { setData(dataOf(await api.contacts({ ...filter, limit: 100 }))) } catch (err) { toast.error(errText(err, "Could not load contacts")) }
  }, [filter])
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t) }, [load])
  const change = async (p, marketing) => {
    try { await api.setContact(p, marketing); toast.success("Saved"); load() } catch (err) { toast.error(errText(err, "Could not save")) }
  }
  const c = data?.counts || {}
  return (
    <div className="space-y-4">
      <div className={`${card} text-sm text-neutral-700`}>
        Customers who reply <b>STOP</b> are opted out of offers automatically (order updates still reach them); <b>START</b> opts them back in.
        Opted-out customers are always left out of campaigns.
        <div className="mt-3 flex flex-wrap gap-3">
          <Pill tone="green">{c.opted_in || 0} opted in</Pill>
          <Pill tone="red">{c.opted_out || 0} opted out</Pill>
          <Pill>{c.unknown || 0} not asked</Pill>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Search"><input className={`${input} w-64`} value={filter.search} onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))} placeholder="Name or number" /></Field>
        <Field label="Show">
          <select className={`${input} w-44`} value={filter.marketing} onChange={(e) => setFilter((f) => ({ ...f, marketing: e.target.value }))}>
            <option value="">Everyone</option>
            <option value="opted_in">Opted in</option>
            <option value="opted_out">Opted out</option>
            <option value="unknown">Not asked</option>
          </select>
        </Field>
        <div className="flex-1" />
        <Field label="Add or change a number"><input className={`${input} w-48`} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" /></Field>
        <button type="button" className={btnLight} disabled={!phone} onClick={() => change(phone, "opted_in")}>Opt in</button>
        <button type="button" className={btnLight} disabled={!phone} onClick={() => change(phone, "opted_out")}>Opt out</button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 text-xs text-neutral-500"><tr>{["Customer", "Offers", "Changed", "By", "Last message from them", ""].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
          <tbody>
            {!data ? <tr><td colSpan={6}><Spinner /></td></tr>
              : !data.contacts.length ? <tr><td colSpan={6} className="px-4 py-8 text-center text-neutral-500">No contacts yet. They appear when a customer messages the number or opts in or out.</td></tr>
                : data.contacts.map((x) => (
                  <tr key={x.phone} className="border-t">
                    <td className="px-4 py-2.5">{x.name || "-"} <span className="text-neutral-500">{fmtPhone(x.phone)}</span></td>
                    <td className="px-4 py-2.5"><Pill tone={x.marketing === "opted_in" ? "green" : x.marketing === "opted_out" ? "red" : "neutral"}>{x.marketing.replace("_", " ")}</Pill></td>
                    <td className="px-4 py-2.5 text-neutral-500">{fmtDate(x.marketingChangedAt)}</td>
                    <td className="px-4 py-2.5 text-neutral-500">{x.marketingChangedBy?.startsWith("customer") ? "Customer" : x.marketingChangedBy ? "Admin" : ""}</td>
                    <td className="px-4 py-2.5 text-neutral-500">{fmtDate(x.lastInboundAt)}</td>
                    <td className="px-4 py-2.5">
                      {x.marketing === "opted_out"
                        ? <button type="button" className="text-xs font-semibold hover:underline" onClick={() => change(x.phone, "opted_in")}>Opt in</button>
                        : <button type="button" className="text-xs font-semibold text-red-600 hover:underline" onClick={() => change(x.phone, "opted_out")}>Opt out</button>}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* -------------------------------------------------------- order alerts -- */

function AlertEvent({ eventKey, label, cfg, onChange, templates, placeholders }) {
  const approved = templates.filter((t) => t.status === "APPROVED")
  const template = approved.find((t) => t.name === cfg.templateName && t.language === cfg.language)
  const values = { header: cfg.header || {}, body: cfg.body || {}, buttons: cfg.buttons || {} }
  return (
    <div className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">{label}</p>
          <p className="text-xs text-neutral-500">Food and grocery / medical orders</p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={Boolean(cfg.enabled)} onChange={(e) => onChange({ ...cfg, enabled: e.target.checked })} /> Send
        </label>
      </div>
      <Field label="Template" hint="Use an approved Utility template (order updates). Create one in the Templates tab.">
        <select className={input} value={cfg.templateName ? `${cfg.templateName}|${cfg.language}` : ""} onChange={(e) => {
          const [templateName = "", language = ""] = e.target.value.split("|")
          onChange({ ...cfg, templateName, language, body: {}, header: {}, buttons: {} })
        }}>
          <option value="">None</option>
          {approved.map((t) => <option key={t.id} value={`${t.name}|${t.language}`}>{t.name} ({t.language}, {t.category.toLowerCase()})</option>)}
        </select>
      </Field>
      {template ? (
        <TemplateFields
          template={template}
          values={values}
          setValues={(fn) => { const next = typeof fn === "function" ? fn(values) : fn; onChange({ ...cfg, ...next }) }}
          media={cfg.headerMedia || {}}
          setMedia={(m) => onChange({ ...cfg, headerMedia: m })}
          placeholders={placeholders}
        />
      ) : null}
      <input type="hidden" value={eventKey} />
    </div>
  )
}

function OrderAlerts({ templates }) {
  const [data, setData] = useState(null)
  const [events, setEvents] = useState({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    (async () => {
      try {
        const d = dataOf(await api.notifications())
        setData(d)
        setEvents(d.events || {})
      } catch (err) { toast.error(errText(err, "Could not load")) }
    })()
  }, [])
  const save = async () => {
    setBusy(true)
    try {
      const d = dataOf(await api.saveNotifications({ events }))
      setEvents(d.events || {})
      toast.success("Order alerts saved")
    } catch (err) { toast.error(errText(err, "Could not save")) } finally { setBusy(false) }
  }
  if (!data) return <Spinner />
  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-700">
        A WhatsApp message goes to the customer automatically at each step you switch on. In the template's variables use{" "}
        {data.placeholders.map((p) => <code key={p} className="mx-0.5 rounded bg-neutral-100 px-1">{`{${p}}`}</code>)}.
        Each order gets each message at most once.
      </p>
      {Object.entries(data.eventLabels).map(([k, label]) => (
        <AlertEvent key={k} eventKey={k} label={label} cfg={events[k] || {}} templates={templates} placeholders={data.placeholders}
          onChange={(cfg) => setEvents((e) => ({ ...e, [k]: cfg }))} />
      ))}
      <button type="button" className={btnDark} disabled={busy} onClick={save}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Save order alerts
      </button>
    </div>
  )
}

/* ---------------------------------------------------------------- page -- */

function Spinner() {
  return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-neutral-400" /></div>
}

export default function WhatsAppMarketing() {
  const [tab, setTab] = useState("overview")
  const [status, setStatus] = useState(null)
  const [report, setReport] = useState(null)
  const [templates, setTemplates] = useState([])
  const [tplLoading, setTplLoading] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.status(), api.report(30)])
      setStatus(dataOf(s))
      setReport(dataOf(r))
    } catch (err) { toast.error(errText(err, "Could not reach WhatsApp")) }
  }, [])
  const loadTemplates = useCallback(async (fresh = false) => {
    setTplLoading(true)
    try { setTemplates(dataOf(await api.templates(fresh)) || []) } catch (err) { toast.error(errText(err, "Could not load templates")) } finally { setTplLoading(false) }
  }, [])
  useEffect(() => { loadStatus(); loadTemplates() }, [loadStatus, loadTemplates])

  return (
    <div className="min-h-screen bg-neutral-50 p-4 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-neutral-900"><MessageCircle className="h-6 w-6 text-emerald-600" /> WhatsApp Marketing</h1>
            <p className="text-sm text-neutral-500">Campaigns, templates, opt-outs and order alerts on {status?.meta?.displayPhoneNumber || "the business number"}</p>
          </div>
          <Link to="/admin/master/whatsapp" className={btnLight}><MessageCircle className="h-4 w-4" /> Inbox{status?.unread ? ` (${status.unread})` : ""}</Link>
        </div>
        <div className="flex gap-1 overflow-x-auto rounded-xl border border-neutral-200 bg-white p-1">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium ${tab === key ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
        {tab === "overview" ? <Overview status={status} report={report} reload={loadStatus} /> : null}
        {tab === "campaigns" ? <Campaigns templates={templates} /> : null}
        {tab === "templates" ? <Templates templates={templates} reload={loadTemplates} loading={tplLoading} /> : null}
        {tab === "contacts" ? <Contacts /> : null}
        {tab === "alerts" ? <OrderAlerts templates={templates} /> : null}
      </div>
    </div>
  )
}
