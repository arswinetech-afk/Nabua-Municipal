/**
 * Multi-block paper-list parser — field request 2026-09-21 (LP-TOPAS SOGOD).
 *
 * Barangay programme lists are not flat rosters. The LP-TOPAS layout puts
 * THREE lists side by side on one sheet —
 *
 *   NAME OF FAMILY LEADER | NAME OF FAMILY HEAD | NAME OF FAMILY MEMBER (REGISTERED VOTER'S)
 *
 * — under two header rows and a title block, with each block carrying its own
 * NO./Surname/First/Middle/Ext/Zone/Contact/Bdate/Sex/Civil/Occupation/Remarks
 * columns. The blocks are row-aligned by family: a head row starts a family,
 * the member rows from that sheet row until the next head row belong to it,
 * and a leader row (when present) sits on the same sheet row as its head.
 * Birthdates in the member block arrive as raw Excel serial numbers.
 *
 * A flat row-per-record importer would glue the three blocks into nonsense,
 * so this module detects the layout and flattens it into canonical rows the
 * existing mapping/validation pipeline already understands — keeping the
 * section role and the remarks codes (AKAP, AICS/4PS, …) as neutral tags and
 * the family grouping as a household number.
 *
 * Pure and dependency-free so REGRESSION 14 can feed it a fixture grid.
 */

export type BlockSection = { role: string; count: number }

export type BlockParseResult = {
  detected: boolean
  /** one entry per side-by-side list, left to right */
  sections: BlockSection[]
  /** canonical rows: keys are the importer's field names */
  rows: Array<Record<string, string>>
  headers: string[]
  /** municipality/barangay read from the title block above the headers */
  meta: { municipality?: string; barangay?: string }
}

export const BLOCK_CANONICAL_HEADERS = [
  'first_name', 'middle_name', 'last_name', 'suffix', 'date_of_birth', 'sex',
  'civil_status', 'contact_number', 'purok', 'occupation', 'remarks', 'tags', 'household_no',
]

const key = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '')

const CELL = (grid: unknown[][], r: number, c: number) => String(grid[r]?.[c] ?? '').trim()

const CIVIL_LETTERS: Record<string, string> = {
  S: 'SINGLE', M: 'MARRIED', W: 'WIDOWED', D: 'SEPARATED', A: 'ANNULLED',
}

/** Excel serial → ISO date; anything else passes through untouched. */
export function excelSerialToDate(v: string): string {
  const n = Number(v)
  if (!/^\d{4,5}$/.test(v.trim()) || !Number.isFinite(n) || n < 15000 || n > 80000) return v
  const ms = Date.UTC(1899, 11, 30) + n * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

function fieldForKey(k: string): string | null {
  if (k === 'surname' || k === 'lastname') return 'last_name'
  if (k === 'firstname' || k === 'givenname') return 'first_name'
  if (k === 'middlename' || k === 'middleinitial') return 'middle_name'
  if (k === 'extname' || k === 'ext' || k === 'suffix') return 'suffix'
  if (k === 'zonestreet' || k === 'zone' || k === 'sitio' || k === 'purok') return 'purok'
  if (k === 'contactno' || k === 'contact' || k === 'mobile' || k === 'phone') return 'contact_number'
  if (k.startsWith('bdate') || k === 'dateofbirth' || k === 'birthdate' || k === 'dob' || k.includes('mmdyyyy')) return 'date_of_birth'
  if (k === 'sex' || k.startsWith('sex') || k === 'gender') return 'sex'
  if (k === 'civilstat' || k === 'civilstatus' || k === 'maritalstatus') return 'civil_status'
  if (k === 'occupation' || k === 'job' || k === 'trabaho') return 'occupation'
  if (k === 'remarks' || k === 'notes' || k === 'tagging') return 'remarks'
  if (k === 'no' || k === 'number') return 'no'
  return null
}

export function parseBlockSheet(
  grid: unknown[][],
  opts: { householdPrefix: string },
): BlockParseResult {
  const empty: BlockParseResult = { detected: false, sections: [], rows: [], headers: [], meta: {} }
  if (!grid?.length) return empty

  // ---- title block: "MUNICIPALITY | NABUA", "BARANGAY | TOPAS SOGOD"
  const meta: { municipality?: string; barangay?: string } = {}
  for (let r = 0; r < Math.min(grid.length, 12); r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      const label = key(CELL(grid, r, c))
      if (label !== 'municipality' && label !== 'barangay') continue
      for (let cc = c + 1; cc < (grid[r]?.length ?? 0); cc++) {
        const v = CELL(grid, r, cc)
        if (v) {
          if (label === 'municipality') meta.municipality = v
          else meta.barangay = v
          break
        }
      }
    }
  }

  // ---- locate the header row: the first row repeating "Surname" per block
  let headerRow = -1
  let surnameCols: number[] = []
  const scanTo = Math.min(grid.length, 40)
  for (let r = 0; r < scanTo; r++) {
    const cols: number[] = []
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      if (/^surname$/i.test(CELL(grid, r, c))) cols.push(c)
    }
    if (cols.length >= 2) { headerRow = r; surnameCols = cols; break }
  }
  if (headerRow < 0) return empty

  // ---- block column ranges, starting at the block's NO. column when present
  const starts = surnameCols.map((s) => (key(CELL(grid, headerRow, s - 1)) === 'no' ? s - 1 : s))
  const blocks = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : Math.max(...grid.map((row) => row?.length ?? 0))
    const cols: Record<string, number> = {}
    for (let c = start; c <= end; c++) {
      const f = fieldForKey(key(CELL(grid, headerRow, c)))
      if (f && cols[f] === undefined) cols[f] = c
    }
    // section title sits in the row(s) above the header, inside this range
    let role = 'FAMILY MEMBER'
    for (let r = Math.max(0, headerRow - 3); r < headerRow; r++) {
      for (let c = start; c <= end; c++) {
        const t = CELL(grid, r, c).toUpperCase()
        if (/FAMILY LEADER/.test(t)) { role = 'FAMILY LEADER'; break }
        if (/FAMILY HEAD/.test(t)) { role = 'FAMILY HEAD'; break }
        if (/FAMILY MEMBER/.test(t)) { role = 'FAMILY MEMBER'; break }
      }
      if (role !== 'FAMILY MEMBER') break
    }
    return { start, end, cols, role }
  })

  // ---- read every block row, keeping the sheet row for family alignment
  type Rec = { row: number; block: number; role: string; rec: Record<string, string> }
  const recs: Rec[] = []
  for (let r = headerRow + 1; r < grid.length; r++) {
    blocks.forEach((b, bi) => {
      const get = (f: string) => (b.cols[f] === undefined ? '' : CELL(grid, r, b.cols[f]))
      const last = get('last_name')
      const first = get('first_name')
      if (!last && !first) return
      const remarks = get('remarks')
      const tags = [b.role, ...(remarks ? [remarks] : [])].join('; ')
      const civilRaw = get('civil_status').toUpperCase()
      recs.push({
        row: r, block: bi, role: b.role,
        rec: {
          last_name: last, first_name: first, middle_name: get('middle_name'), suffix: get('suffix'),
          date_of_birth: excelSerialToDate(get('date_of_birth')),
          sex: get('sex'), civil_status: CIVIL_LETTERS[civilRaw] ?? civilRaw,
          contact_number: get('contact_number'), purok: get('purok'),
          occupation: get('occupation'), remarks, tags, household_no: '',
        },
      })
    })
  }
  if (recs.length === 0) return empty

  // ---- family grouping: a head row opens a household; leaders and members
  //      on or after that sheet row (until the next head) belong to it
  let headCount = 0
  let currentHH = ''
  const roleOrder: Record<string, number> = { 'FAMILY HEAD': 0, 'FAMILY LEADER': 1, 'FAMILY MEMBER': 2 }
  const ordered = [...recs].sort((a, b) => a.row - b.row || (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3) || a.block - b.block)
  for (const item of ordered) {
    if (item.role === 'FAMILY HEAD') {
      headCount += 1
      currentHH = `${opts.householdPrefix}-F${String(headCount).padStart(3, '0')}`
    }
    item.rec.household_no = currentHH
  }

  const sections = blocks.map((b, bi) => ({ role: b.role, count: recs.filter((x) => x.block === bi).length }))
  return {
    detected: true,
    sections,
    rows: ordered.map((x) => x.rec),
    headers: [...BLOCK_CANONICAL_HEADERS],
    meta,
  }
}
