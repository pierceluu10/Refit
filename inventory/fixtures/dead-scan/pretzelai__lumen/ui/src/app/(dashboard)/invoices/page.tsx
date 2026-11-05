// Excerpt of pretzelai/lumen at c689c56b3241, ui/src/app/(dashboard)/invoices/page.tsx.
export const filtered = (tableData) =>
  tableData.filter((invoice) => {
    const type = invoice.subscription ? 'subscription' : 'one-off';
    return type;
  });
