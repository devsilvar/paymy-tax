-- Index backing generateInvoiceNumber's "last invoice in this business" lookup.
-- We order by createdAt DESC (not invoiceNumber DESC) because lexicographic
-- sort on the string breaks once the suffix grows past 3 digits.
CREATE INDEX "invoices_business_id_created_at_idx" ON "invoices"("business_id", "created_at" DESC);
