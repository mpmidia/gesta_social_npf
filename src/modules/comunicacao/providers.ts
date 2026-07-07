// ============================================================
// STUBS de provedores de comunicação (E-mail e WhatsApp).
// Em produção, substituir pelas chamadas reais às APIs REST
// (ex.: Resend/SendGrid para e-mail, WhatsApp Business Cloud API).
// As credenciais devem ser configuradas via `wrangler secret put`
// e NUNCA expostas no frontend.
// ============================================================

export interface SendResult {
  ok: boolean
  providerResponse: string
}

export async function sendEmailStub(to: string, subject: string, body: string): Promise<SendResult> {
  // TODO: substituir por chamada real, ex.:
  // const resp = await fetch('https://api.resend.com/emails', {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ from: 'no-reply@seudominio.org', to, subject, html: body })
  // })
  console.log(`[STUB e-mail] Para: ${to} | Assunto: ${subject} | Corpo: ${body.slice(0, 80)}...`)
  return { ok: true, providerResponse: 'STUB: e-mail simulado com sucesso (nenhum provedor real configurado).' }
}

export async function sendWhatsAppStub(to: string, body: string): Promise<SendResult> {
  // TODO: substituir por chamada real à WhatsApp Business Cloud API, ex.:
  // const resp = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  // })
  console.log(`[STUB whatsapp] Para: ${to} | Corpo: ${body.slice(0, 80)}...`)
  return { ok: true, providerResponse: 'STUB: WhatsApp simulado com sucesso (nenhum provedor real configurado).' }
}
