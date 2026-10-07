/**
 * Payload de Contas a Receber — regra de derivação da venda (frontend).
 *
 * Pura e testável (sem DOM): usada pela página de Recebíveis para montar o
 * submit. A REGRA definitiva continua no backend — esta função apenas
 * representa a derivação corretamente e NUNCA substitui a validação servidor:
 * mesmo que alguém adultere o payload, o backend rejeita divergências (400).
 *
 * Por que existe: campos visualmente travados (selects usam `disabled`, que os
 * exclui do FormData) não podem fazer o valor da venda "sumir" do submit —
 * a venda selecionada é a fonte dos dados derivados.
 */

/** Localiza a venda selecionada na lista carregada. */
export function resolveSale(sales, saleId) {
  if (!saleId) return null;
  return sales.find((s) => String(s.id) === String(saleId)) || null;
}

/**
 * Monta o payload do formulário. Com venda selecionada, valor/cliente/loja
 * vêm da venda (independente do que os campos visuais enviariam); sem venda,
 * usa os campos do formulário (lançamento manual).
 */
export function buildReceivablePayload(formData, sales) {
  const sale = resolveSale(sales, formData.sale_id);
  const payload = {
    description: formData.description,
    due_date: formData.due_date,
    issue_date: formData.issue_date || undefined,
    notes: formData.notes || null,
  };
  if (sale) {
    payload.sale_id = sale.id;
    payload.amount = sale.amount_cents / 100;
    payload.customer_id = sale.customer_id || null;
    payload.store_id = sale.store_id || null;
  } else {
    payload.amount = formData.amount;
    payload.customer_id = formData.customer_id ? Number(formData.customer_id) : null;
    payload.store_id = formData.store_id ? Number(formData.store_id) : null;
  }
  return payload;
}
