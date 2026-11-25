import { crc32 } from "node:zlib";
import { pricingFormula, pricingSheet, pricingTotalCents, type PricingInputs } from "./workbook-pricing";

export const xlsxContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pkgRelNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const xml = (content: string) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + content;

// XLSX is a ZIP package. These bounded, generated XML parts use stored entries.
function zipParts(parts: Record<string, string>) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(parts)) {
    const name = Buffer.from(path), data = Buffer.from(xml(content)), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12); // January 1, 1980 in DOS format.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function cellLabel(row: number, label: string) {
  return `<c r="A${row}" t="inlineStr"><is><t>${label}</t></is></c>`;
}
function row(index: number, label: string, numberCell = "") {
  return `<row r="${index}">${cellLabel(index, label)}${numberCell}</row>`;
}
export function exportPricingWorkbook(inputs: PricingInputs) {
  const sheetRows = [
    row(1, "Partner quote (USD)"),
    row(2, "Quantity", `<c r="B2"><v>${inputs.quantity}</v></c>`),
    row(3, "Unit price", `<c r="B3" s="1"><v>${(inputs.unitPriceCents / 100).toFixed(2)}</v></c>`),
    row(4, "Discount", `<c r="B4" s="2"><v>${(inputs.discountBps / 10_000).toFixed(4)}</v></c>`),
    row(5, "Quote total", `<c r="B5" s="1"><f>${pricingFormula}</f><v>${(pricingTotalCents(inputs) / 100).toFixed(2)}</v></c>`),
  ].join("");
  return zipParts({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    "_rels/.rels": `<Relationships xmlns="${pkgRelNs}"><Relationship Id="rId1" Type="${relNs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${sheetNs}" xmlns:r="${relNs}"><sheets><sheet name="${pricingSheet}" sheetId="1" r:id="rId1"/></sheets><calcPr calcMode="auto" fullCalcOnLoad="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${pkgRelNs}"><Relationship Id="rId1" Type="${relNs}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relNs}/styles" Target="styles.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${sheetNs}"><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="20" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`,
    "xl/styles.xml": `<styleSheet xmlns="${sheetNs}">` +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  });
}
