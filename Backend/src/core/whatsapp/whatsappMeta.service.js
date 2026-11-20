/**
 * What we ask Meta directly: the number's health and limits, the approved
 * message templates, submitting a new template for approval, and uploading
 * header media. Credentials come from Master settings (whatsappCredentials).
 */
import { whatsappCredentials } from '../settings/platformProfile.service.js';

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const creds = () => {
  const c = whatsappCredentials();
  if (!c.accessToken || !c.phoneNumberId) {
    throw bad('WhatsApp is not connected: save the access token and phone number id in Master settings first');
  }
  return c;
};

async function graph(path, { method = 'GET', body, form } = {}) {
  const c = creds();
  const headers = { Authorization: `Bearer ${c.accessToken}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`https://graph.facebook.com/${c.version}/${path}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error || {};
    throw bad(e.error_user_msg || e.message || `Meta answered ${res.status}`, res.status >= 500 ? 502 : 400);
  }
  return json;
}

/** TIER_250 -> 250, TIER_1K -> 1000, TIER_UNLIMITED -> Infinity. */
export const tierLimit = (tier = '') => {
  const m = /^TIER_(\d+)(K?)$/i.exec(String(tier));
  if (!m) return /UNLIMITED/i.test(tier) ? Infinity : 250;
  return Number(m[1]) * (m[2] ? 1000 : 1);
};

let phoneCache = { at: 0, value: null };

/** The business number as Meta sees it: name, status, quality, daily limit. */
export async function phoneInfo({ fresh = false } = {}) {
  if (!fresh && phoneCache.value && Date.now() - phoneCache.at < 5 * 60 * 1000) return phoneCache.value;
  const c = creds();
  const p = await graph(`${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,status,messaging_limit_tier,code_verification_status,name_status`);
  const value = {
    phoneNumberId: c.phoneNumberId,
    businessAccountId: c.businessAccountId,
    displayPhoneNumber: p.display_phone_number || '',
    verifiedName: p.verified_name || '',
    status: p.status || '',
    qualityRating: p.quality_rating || '',
    messagingLimitTier: p.messaging_limit_tier || '',
    dailyLimit: tierLimit(p.messaging_limit_tier),
    nameStatus: p.name_status || '',
  };
  phoneCache = { at: Date.now(), value };
  return value;
}

let templateCache = { at: 0, value: null };

/** Every template on the business account, with its parts. */
export async function listTemplates({ fresh = false } = {}) {
  if (!fresh && templateCache.value && Date.now() - templateCache.at < 2 * 60 * 1000) return templateCache.value;
  const c = creds();
  if (!c.businessAccountId) throw bad('Save the WhatsApp business account id in Master settings first');
  const out = [];
  let next = `${encodeURIComponent(c.businessAccountId)}/message_templates?fields=id,name,status,category,language,parameter_format,components,rejected_reason,quality_score&limit=100`;
  for (let i = 0; next && i < 10; i += 1) {
    const page = await graph(next);
    out.push(...(page.data || []));
    const after = page.paging?.cursors?.after;
    next = page.paging?.next && after
      ? `${encodeURIComponent(c.businessAccountId)}/message_templates?fields=id,name,status,category,language,parameter_format,components,rejected_reason,quality_score&limit=100&after=${encodeURIComponent(after)}`
      : null;
  }
  const value = out.map((t) => ({ ...t, variables: templateVariables(t) }));
  templateCache = { at: Date.now(), value };
  return value;
}

export async function findTemplate(name, language) {
  const list = await listTemplates();
  return list.find((t) => t.name === name && t.language === language) || null;
}

const VAR_RX = /{{\s*([A-Za-z0-9_]+)\s*}}/g;
const varsIn = (text = '') => [...new Set([...String(text).matchAll(VAR_RX)].map((m) => m[1]))];

/**
 * What a template needs filled in: header text variables, header media format,
 * body variables, and URL-button variables. Keys are "1", "2"... for
 * positional templates and the variable names for named ones.
 */
export function templateVariables(t = {}) {
  const v = { headerFormat: '', header: [], body: [], buttons: [], bodyText: '', headerText: '', footerText: '', buttonLabels: [] };
  for (const comp of t.components || []) {
    if (comp.type === 'HEADER') {
      v.headerFormat = comp.format || 'TEXT';
      if (comp.format === 'TEXT') {
        v.headerText = comp.text || '';
        v.header = varsIn(comp.text);
      }
    } else if (comp.type === 'BODY') {
      v.bodyText = comp.text || '';
      v.body = varsIn(comp.text);
    } else if (comp.type === 'FOOTER') {
      v.footerText = comp.text || '';
    } else if (comp.type === 'BUTTONS') {
      (comp.buttons || []).forEach((b, index) => {
        v.buttonLabels.push(b.text || b.type);
        if (b.type === 'URL' && varsIn(b.url).length) v.buttons.push({ index, label: b.text || 'Link', url: b.url });
      });
    }
  }
  return v;
}

/** Fill {name} / {phone} / {order_id}... in a value from the context. */
export const fillValue = (value, ctx = {}) => String(value ?? '').replace(/{([a-z_]+)}/g, (m, key) => (ctx[key] !== undefined && ctx[key] !== null ? String(ctx[key]) : m));

/**
 * The `template` object for a send. `values` = { header: {}, body: {}, buttons: {} },
 * `media` = { format, mediaId, link, filename }, `ctx` fills {placeholders}.
 */
export function buildTemplatePayload(t, values = {}, media = {}, ctx = {}) {
  const v = t.variables || templateVariables(t);
  const named = String(t.parameter_format || '').toUpperCase() === 'NAMED';
  const param = (key, raw) => {
    const text = fillValue(raw, ctx).trim() || '-';
    return named ? { type: 'text', parameter_name: key, text } : { type: 'text', text };
  };
  const components = [];

  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(v.headerFormat)) {
    const kind = v.headerFormat.toLowerCase();
    const ref = media.mediaId ? { id: media.mediaId } : media.link ? { link: media.link } : null;
    if (!ref) throw bad(`This template has a ${kind} header: upload the ${kind} first`);
    if (kind === 'document' && media.filename) ref.filename = media.filename;
    components.push({ type: 'header', parameters: [{ type: kind, [kind]: ref }] });
  } else if (v.header.length) {
    components.push({ type: 'header', parameters: v.header.map((k) => param(k, values.header?.[k])) });
  }
  if (v.body.length) {
    components.push({ type: 'body', parameters: v.body.map((k) => param(k, values.body?.[k])) });
  }
  for (const b of v.buttons) {
    const raw = values.buttons?.[b.index] ?? values.buttons?.[String(b.index)];
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(b.index),
      parameters: [{ type: 'text', text: fillValue(raw, ctx).trim() || '-' }],
    });
  }
  return {
    type: 'template',
    template: {
      name: t.name,
      language: { code: t.language },
      ...(components.length ? { components } : {}),
    },
  };
}

/**
 * Submit a new template to Meta for approval. Text header, body with {{1}}
 * style variables (examples required by Meta), optional footer and buttons.
 */
export async function createTemplate(input = {}) {
  const c = creds();
  if (!c.businessAccountId) throw bad('Save the WhatsApp business account id in Master settings first');
  const name = String(input.name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) throw bad('Give the template a name (letters, numbers and _)');
  const category = String(input.category || '').toUpperCase();
  if (!['MARKETING', 'UTILITY'].includes(category)) throw bad('Category must be Marketing or Utility');
  const language = String(input.language || 'en').trim();
  const body = String(input.body || '').trim();
  if (!body) throw bad('Write the message text');
  if (body.length > 1024) throw bad('The message text can be at most 1024 characters');

  const bodyVars = varsIn(body);
  if (bodyVars.some((k) => !/^\d+$/.test(k))) throw bad('Use numbered variables like {{1}}, {{2}} in the text');
  const examples = Array.isArray(input.bodyExamples) ? input.bodyExamples.map((x) => String(x || '').trim()) : [];
  if (bodyVars.length && (examples.length < bodyVars.length || examples.some((x) => !x))) {
    throw bad('Give an example value for every variable: Meta needs them to review the template');
  }

  const components = [];
  const headerText = String(input.headerText || '').trim();
  if (headerText) {
    if (varsIn(headerText).length) throw bad('Keep the header plain text (no variables)');
    components.push({ type: 'HEADER', format: 'TEXT', text: headerText.slice(0, 60) });
  }
  components.push({
    type: 'BODY',
    text: body,
    ...(bodyVars.length ? { example: { body_text: [examples.slice(0, bodyVars.length)] } } : {}),
  });
  const footer = String(input.footer || '').trim();
  if (footer) components.push({ type: 'FOOTER', text: footer.slice(0, 60) });
  const buttons = [];
  for (const b of Array.isArray(input.buttons) ? input.buttons : []) {
    const text = String(b?.text || '').trim().slice(0, 25);
    if (!text) continue;
    if (b.type === 'URL') {
      const url = String(b.url || '').trim();
      if (!/^https:\/\//.test(url)) throw bad('A link button needs a https:// address');
      buttons.push({ type: 'URL', text, url });
    } else {
      buttons.push({ type: 'QUICK_REPLY', text });
    }
  }
  if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.slice(0, 10) });

  const result = await graph(`${encodeURIComponent(c.businessAccountId)}/message_templates`, {
    method: 'POST',
    body: { name, category, language, components },
  });
  templateCache = { at: 0, value: null };
  return { id: result.id, status: result.status, category: result.category, name, language };
}

/** Upload an image / video / document to Meta; returns its media id (kept 30 days). */
export async function uploadMedia({ buffer, mimetype, filename }) {
  const c = creds();
  if (!buffer?.length) throw bad('Choose a file to upload');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimetype);
  form.append('file', new Blob([buffer], { type: mimetype }), filename || 'upload');
  const result = await graph(`${encodeURIComponent(c.phoneNumberId)}/media`, { method: 'POST', form });
  if (!result.id) throw bad('Meta did not return a media id');
  return { mediaId: result.id };
}
