// OpenDialer-authored transactional email. Inline styles and solid surfaces also work without a stylesheet.
type Message = {
  heading: string
  description: string
} & (
  | { action: { label: string; url: URL }; code?: string }
  | { unsubscribe: URL }
)

function escape(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function webLink(url: URL) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Expected an HTTP email link')
  return escape(url.href)
}

export function transactionalEmail(message: Message) {
  const font = "-apple-system,BlinkMacSystemFont,'SF Pro Text',Inter,system-ui,Arial,sans-serif"
  let text: string
  let controls: string
  if ('action' in message) {
    const link = webLink(message.action.url)
    text = message.description + '\n\n' + message.action.url.href + (message.code?'\n\nOr enter this code:\n' + message.code:'')
    controls = `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#0A84FF" style="border-radius:6px;mso-padding-alt:6px 12px"><a href="${link}" style="display:inline-block;background-color:#0A84FF;border-radius:6px;padding:6px 12px;color:#FFFFFF;font-size:13px;font-weight:600;line-height:18px;text-decoration:none">${escape(message.action.label)}</a></td></tr></table>`
    if(message.code)controls+=`<p style="margin:18px 0 6px;font-size:12px;color:#ACACB0">Or enter this code in OpenDialer.</p>
<div style="background-color:#29292B;padding:10px 12px;border-radius:8px;font-size:13px;line-height:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;word-break:break-all">${escape(message.code)}</div>`
  } else {
    text = message.description + '\n\nUnsubscribe from updates about this feature:\n' + message.unsubscribe.href
    controls = `<p style="margin:16px 0 0;font-size:12px"><a href="${webLink(message.unsubscribe)}" style="color:#0A84FF;text-decoration:underline">Unsubscribe From This Feature</a></p>`
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escape(message.heading)}</title></head>
<body bgcolor="#0A0F16" style="margin:0;background-color:#0A0F16;color:#F2F2F7;font-family:${font};font-size:13px;line-height:1.35;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0A0F16"><tr><td align="center" style="padding:16px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#1E1E20" style="max-width:520px;table-layout:fixed;border-radius:12px;color:#F2F2F7;font-family:${font}">
<tr><td bgcolor="#262628" style="border-radius:12px 12px 0 0;padding:10px 18px;border-bottom:1px solid #38383A;font-size:13px;font-weight:700;text-align:left">OpenDialer</td></tr>
<tr><td align="left" style="padding:18px;font-size:13px;line-height:1.35;overflow-wrap:anywhere"><h1 style="margin:0 0 8px;font-size:20px;line-height:1.35;font-weight:700">${escape(message.heading)}</h1>
<p style="margin:0 0 16px;font-size:13px;line-height:1.35">${escape(message.description)}</p>${controls}</td></tr>
</table></td></tr></table></body></html>`
  return { text, html }
}
