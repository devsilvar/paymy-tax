/**
 * Build the Sales Import .xlsx template.
 *
 * Why generate it dynamically instead of shipping a static file?
 *   - The `source` enum is the source-of-truth. If we add a new source value,
 *     the template should pick it up automatically — no risk of docs drifting.
 *   - We can put the user's business name in the filename / footer later.
 *
 * Template structure:
 *   Sheet 1 "Sales"        — headers (row 1) + 3 example rows (rows 2-4, greyed)
 *   Sheet 2 "Instructions" — column-by-column help + source enum reference
 *
 * Data validation: the `source` column has a dropdown of valid enum values
 * on rows 2-101 (our 100-row cap), so users pick instead of type.
 */

import ExcelJS from 'exceljs';

const SOURCE_VALUES = ['bank_transfer', 'paycode', 'pos', 'online_store', 'manual'] as const;

const HEADERS = [
  { key: 'transaction_date', label: 'transaction_date', width: 18 },
  { key: 'amount', label: 'amount', width: 14 },
  { key: 'source', label: 'payment_method', width: 18 },
  { key: 'customer_name', label: 'customer_name', width: 24 },
  { key: 'description', label: 'description', width: 32 },
  { key: 'reference_id', label: 'reference_id', width: 20 },
] as const;

const EXAMPLE_ROWS: Array<Record<string, string | number>> = [
  {
    transaction_date: '2026-04-01',
    amount: 50000,
    source: 'pos',
    customer_name: 'Aisha Bello',
    description: 'Hair dryer — 2 units',
    reference_id: 'POS-32242',
  },
  {
    transaction_date: '2026-04-03',
    amount: 120000,
    source: 'bank_transfer',
    customer_name: 'Tunde Oke',
    description: 'Bulk order — salon supplies',
    reference_id: '',
  },
  {
    transaction_date: '2026-04-05',
    amount: 8500,
    source: 'manual',
    customer_name: 'Wale adejugbagbe',
    description: 'Walk-in customer — cash',
    reference_id: '',
  },
];

export async function buildSalesImportTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PayMyTax by WallX';
  wb.created = new Date();

  // ─── Sheet 1: Sales ─────────────────────────────────────────
  const sales = wb.addWorksheet('Sales', {
    views: [{ state: 'frozen', ySplit: 1 }], // freeze header row
  });

  // Set columns (drives widths + keys for row.values lookups)
  sales.columns = HEADERS.map((h) => ({ header: h.label, key: h.key, width: h.width }));

  // Header styling — navy fill, white bold text
  const header = sales.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E3A8A' }, // primary-900 (navy)
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = {
      bottom: { style: 'medium', color: { argb: 'FF1E3A8A' } },
    };
  });

  // Example rows — added italic + grey so users know to replace them
  EXAMPLE_ROWS.forEach((row) => {
    const added = sales.addRow(row);
    added.eachCell((cell) => {
      cell.font = { italic: true, color: { argb: 'FF9CA3AF' } }; // gray-400
    });
  });

  // Format the `amount` column as naira
  sales.getColumn('amount').numFmt = '#,##0.00';
  // Format the date column
  sales.getColumn('transaction_date').numFmt = 'yyyy-mm-dd';

  // Data validation: source dropdown — apply to rows 2..101 (our 100-row cap + 3 examples)
  // ExcelJS uses `,` separator and requires quotes for literal lists
  const sourceColLetter = sales.getColumn('source').letter;
  for (let r = 2; r <= 101; r++) {
    sales.getCell(`${sourceColLetter}${r}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [`"${SOURCE_VALUES.join(',')}"`],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid source',
      error: `Pick one of: ${SOURCE_VALUES.join(', ')}`,
    };
  }

  // ─── Sheet 2: Instructions ──────────────────────────────────
  const help = wb.addWorksheet('Instructions');
  help.columns = [
    { header: 'Field', key: 'field', width: 22 },
    { header: 'Required?', key: 'required', width: 12 },
    { header: 'Format', key: 'format', width: 38 },
    { header: 'Example', key: 'example', width: 22 },
  ];

  const helpHeader = help.getRow(1);
  helpHeader.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  });

  const helpRows = [
    {
      field: 'transaction_date',
      required: 'Yes',
      format: 'Excel date, YYYY-MM-DD, or DD/MM/YYYY',
      example: '2026-04-15',
    },
    {
      field: 'amount',
      required: 'Yes',
      format: 'Number, in naira. Commas and ₦ sign are OK (e.g. ₦150,000).',
      example: '150000',
    },
    {
      field: 'source',
      required: 'Yes',
      format: `One of: ${SOURCE_VALUES.join(', ')}. Use the dropdown on sheet 1.`,
      example: 'pos',
    },
    {
      field: 'customer_name',
      required: 'No',
      format: 'Up to 200 characters. Leave blank for walk-in customers.',
      example: 'Aisha Bello',
    },
    {
      field: 'description',
      required: 'No',
      format: 'Up to 500 characters. What was sold.',
      example: 'Hair dryer — 2 units',
    },
    {
      field: 'reference_id',
      required: 'No',
      format:
        'Transaction reference from your POS, bank, etc. Used to detect duplicates. Leave blank for cash sales.',
      example: 'POS-0001',
    },
  ];
  helpRows.forEach((r) => help.addRow(r));

  // Notes section below the table
  help.addRow([]);
  help.addRow(['Notes']).getCell(1).font = { bold: true, size: 12 };
  const notes = [
    '• Maximum 100 rows per upload. For larger datasets, split into multiple files.',
    '• Duplicate detection: rows with the same (source + reference_id) are flagged and skipped.',
    '• Rows in a finalized or paid month are skipped (the month is locked).',
    '• After uploading, you will see a preview of valid/invalid rows before confirming.',
    '• Empty rows are ignored. Header order does not matter.',
    `• Accepted file types: .xlsx (Excel) and .csv.`,
  ];
  notes.forEach((n) => help.addRow([n]));

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export const SALES_IMPORT_ROW_CAP = 100;
export const SALES_IMPORT_SOURCES = SOURCE_VALUES;
