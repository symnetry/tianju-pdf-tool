const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { PDFDocument: PDFLibDocument } = require("pdf-lib");
const { readFile, writeFile } = require("fs/promises");
const {
	optimizePickingData,
	parseShelfPosition,
} = require("./optimize-pick-batches");



const DEFAULT_OPTIMIZE_BOX_SIZE = 15;


function sanitizeFileName(name) {
	return name.toLowerCase().replace(/[\\/:"*?<>|]/g, "-").replace(/\s+/g, "_");
}

function downloadFile(url, filePath) {
	return new Promise((resolve, reject) => {
		https
			.get(url, (response) => {
				if (response.statusCode === 200) {
					const fileStream = fs.createWriteStream(filePath);
					response.pipe(fileStream);
					fileStream.on("finish", () => {
						fileStream.close();
						resolve();
					});
				} else if (
					response.statusCode === 301 ||
					response.statusCode === 302
				) {
					downloadFile(response.headers.location, filePath)
						.then(resolve)
						.catch(reject);
				} else {
					reject(
						new Error(
							`Failed to download file, status code: ${response.statusCode}`,
						),
					);
				}
			})
			.on("error", reject);
	});
}

function normalizeCoverSkuLines(upc) {
	if (Array.isArray(upc)) {
		return upc
			.map((item) => String(item || "").trim())
			.filter(Boolean);
	}
	const text = String(upc || "").trim();
	return text ? [text] : [];
}

function buildMultipleOrderSignature(upcDescList) {
	const lines = normalizeCoverSkuLines(upcDescList);
	return lines.join("||");
}

function splitMultipleOrdersByExactSku(upcOrders) {
	const groupMap = new Map();

	for (const order of upcOrders || []) {
		const skuLines = normalizeCoverSkuLines(order?.upcDescList);
		const signature = buildMultipleOrderSignature(skuLines) || `__EMPTY__${order?.orderNo || ""}`;
		if (!groupMap.has(signature)) {
			groupMap.set(signature, {
				signature,
				skuLines,
				orders: [],
			});
		}
		groupMap.get(signature).orders.push(order);
	}

	return [...groupMap.values()];
}

function formatCoverSkuText(upc) {
	const lines = normalizeCoverSkuLines(upc);
	if (Array.isArray(upc)) {
		return lines.length ? `SKU:\n${lines.join("\n")}` : "SKU:";
	}
	return lines.length ? `SKU: ${lines[0]}` : "SKU:";
}

function generateCoverPage(upc, pcsCount, outputPath) {
	const doc = new PDFDocument({
		margin: 10,
		size: [320, 500],
	});
	doc.pipe(fs.createWriteStream(outputPath));

	const isMultipleCover = Array.isArray(upc);
	doc.fontSize(24).text(formatCoverSkuText(upc), 24, 50, {
		align: isMultipleCover ? "left" : "center",
		width: 272,
	});

	doc.fontSize(14).text(
		`${pcsCount}Pcs`,
		10,
		420,
		{ align: "center" },
	);

	doc.end();
	console.log(`已生成Cover页: ${outputPath}`);
}

function comparePickListShelves(a, b) {
	const pa = parseShelfPosition(a);
	const pb = parseShelfPosition(b);
	if (pa.row !== pb.row) return pa.row - pb.row;
	if (pa.number !== pb.number) return pa.number - pb.number;
	if (pa.side !== pb.side) return pa.side - pb.side;
	if (pa.detail !== pb.detail) return pa.detail - pb.detail;
	return String(a || "").localeCompare(String(b || ""), undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

function comparePickListItems(a, b) {
	const shelfCompare = comparePickListShelves(a?.shelfName, b?.shelfName);
	if (shelfCompare !== 0) return shelfCompare;

	const zoneCompare = String(a?.zoneName || "").localeCompare(

		String(b?.zoneName || ""),
		undefined,
		{ numeric: true, sensitivity: "base" },
	);
	if (zoneCompare !== 0) return zoneCompare;

	const upcCompare = String(a?.upc || a?.sku || "").localeCompare(
		String(b?.upc || b?.sku || ""),
		undefined,
		{ numeric: true, sensitivity: "base" },
	);
	if (upcCompare !== 0) return upcCompare;

	return String(a?.orderNo || "").localeCompare(String(b?.orderNo || ""), undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

function buildPickListSections(labelDesc) {
	const sections = [];

	for (const zone of Array.isArray(labelDesc) ? labelDesc : []) {
		const zoneName = zone?.zoneName || "UNKNOWN";
		const items = (Array.isArray(zone?.items) ? zone.items : []).map((item) => ({
			...item,
			zoneName: item?.zoneName || zoneName,
			shelfName: item?.shelfName || "UNKNOWN",
			upc: item?.upc || item?.sku || "",
			num: Number(item?.num) || 0,
		}));

		items.sort(comparePickListItems);
		sections.push({
			zoneName,
			items,
		});
	}

	return sections;
}


function drawPickListPageHeader(doc, batchItem, layout, showTitle = false) {
	const titleY = layout.margin + 2;
	const infoY = showTitle ? titleY + 28 : titleY;

	if (showTitle) {
		doc.font("Helvetica-Bold").fontSize(16).text(
			"Picking Details",
			layout.margin,
			titleY,
			{
				width: layout.pageWidth - layout.margin * 2,
				align: "center",
			},
		);
	}

	doc.font("Helvetica").fontSize(11).text(
		`Pick No: ${batchItem.pickNo}`,
		layout.startX,
		infoY,
		{
			width: 145,
		},
	);
	doc.text(
		`Total Pick Items: ${layout.totalPickItems}`,
		layout.startX + 145,
		infoY,
		{
			width: layout.contentWidth - 145,
			align: "right",
		},
	);

	return infoY + 20;
}

function measureTableRowHeight(doc, row, colWidths, options) {
	const {
		fontSize,
		paddingX,
		paddingY,
		baseRowHeight,
		lineGap,
	} = options;
	let maxTextHeight = 0;

	doc.fontSize(fontSize);
	for (let i = 0; i < colWidths.length; i++) {
		const text = String(row[i] || "");
		const textHeight = doc.heightOfString(text, {
			width: Math.max(colWidths[i] - paddingX * 2, 10),
			align: "center",
			lineGap,
		});
		maxTextHeight = Math.max(maxTextHeight, textHeight);
	}

	return Math.max(baseRowHeight, Math.ceil(maxTextHeight + paddingY * 2));
}

function drawTableRow(doc, startX, startY, row, colWidths, rowHeight, options) {
	const {
		fontName,
		fontSize,
		paddingX,
		paddingY,
		lineGap,
	} = options;
	let currentX = startX;

	doc.font(fontName).fontSize(fontSize);
	for (let i = 0; i < colWidths.length; i++) {
		const cellWidth = colWidths[i];
		const text = String(row[i] || "");

		doc.rect(currentX, startY, cellWidth, rowHeight).stroke();
		doc.text(text, currentX + paddingX, startY + paddingY, {
			width: Math.max(cellWidth - paddingX * 2, 10),
			align: "center",
			lineGap,
		});
		currentX += cellWidth;
	}

	return startY + rowHeight;
}

function generatePickList(batchItem, folderPath) {
	const doc = new PDFDocument({
		margin: 10,
		size: [320, 500],
	});
	const outputPath = path.join(folderPath, "pick-list.pdf");
	doc.pipe(fs.createWriteStream(outputPath));

	const pageWidth = 320;
	const pageHeight = 500;
	const margin = 10;
	const contentWidth = 294;
	const startX = (pageWidth - contentWidth) / 2;
	const maxContentY = pageHeight - margin;
	const colWidths = [112, 118, 64];
	const headers = ["UPC", "Location", "Qty"];
	const tableOptions = {
		baseRowHeight: 22,
		headerFontSize: 10,
		bodyFontSize: 9,
		paddingX: 6,
		paddingY: 6,
		lineGap: 1,
		maxContentY,
	};
	const sections = buildPickListSections(batchItem.labelDesc);
	const totalPickItems = sections.reduce(
		(sum, section) => sum + section.items.length,
		0,
	);
	const layout = {
		pageWidth,
		contentWidth,
		margin,
		startX,
		totalPickItems,
	};
	const drawPageHeader = (showTitle = false) =>
		drawPickListPageHeader(doc, batchItem, layout, showTitle);
	const headerRowHeight = measureTableRowHeight(doc, headers, colWidths, {
		fontSize: tableOptions.headerFontSize,
		paddingX: tableOptions.paddingX,
		paddingY: tableOptions.paddingY,
		baseRowHeight: tableOptions.baseRowHeight,
		lineGap: tableOptions.lineGap,
	});

	let tableStartY = drawPageHeader(true) + 8;

	sections.forEach((section) => {
		const rows = section.items.map((item) => [
			item.upc,
			item.shelfName,
			String(item.num),
		]);
		const zoneTitleHeight = 20;
		if (tableStartY + zoneTitleHeight + headerRowHeight > maxContentY) {
			doc.addPage();
			tableStartY = drawPageHeader() + 8;
		}

		doc.font("Helvetica-Bold").fontSize(13).text(
			`Zone: ${section.zoneName}`,
			startX,
			tableStartY,
			{
				width: contentWidth,
			},
		);
		tableStartY += zoneTitleHeight;

		tableStartY = drawTable(doc, startX, tableStartY, colWidths, {
			headers,
			rows,
			...tableOptions,
			drawPageHeader: () => drawPageHeader() + 8,
		});
		tableStartY += 12;
	});

	doc.end();
	console.log(`拣货单已生成: ${outputPath}`);
}

function drawTable(doc, startX, startY, colWidths, options) {
	const {
		headers,
		rows,
		baseRowHeight,
		headerFontSize,
		bodyFontSize,
		paddingX,
		paddingY,
		lineGap,
		maxContentY,
		drawPageHeader,
	} = options;
	const headerMeasureOptions = {
		fontSize: headerFontSize,
		paddingX,
		paddingY,
		baseRowHeight,
		lineGap,
	};
	const bodyMeasureOptions = {
		fontSize: bodyFontSize,
		paddingX,
		paddingY,
		baseRowHeight,
		lineGap,
	};
	let currentY = startY;

	const renderHeaderRow = () => {
		const rowHeight = measureTableRowHeight(doc, headers, colWidths, headerMeasureOptions);
		if (currentY + rowHeight > maxContentY) {
			doc.addPage();
			currentY = drawPageHeader();
		}
		currentY = drawTableRow(doc, startX, currentY, headers, colWidths, rowHeight, {
			fontName: "Helvetica-Bold",
			fontSize: headerFontSize,
			paddingX,
			paddingY,
			lineGap,
		});
	};

	renderHeaderRow();

	for (const row of rows) {
		const rowHeight = measureTableRowHeight(doc, row, colWidths, bodyMeasureOptions);
		if (currentY + rowHeight > maxContentY) {
			doc.addPage();
			currentY = drawPageHeader();
			renderHeaderRow();
		}
		currentY = drawTableRow(doc, startX, currentY, row, colWidths, rowHeight, {
			fontName: "Helvetica",
			fontSize: bodyFontSize,
			paddingX,
			paddingY,
			lineGap,
		});
	}

	return currentY;
}




async function mergePDFs(folderPath, batchItem, upcPageRanges, upcUniqueList) {
	try {
		console.log(`开始合成PDF: ${folderPath}`);

		const pdfFiles = fs
			.readdirSync(folderPath)
			.filter(
				(file) =>
					file.endsWith(".pdf") &&
					file !== "merged.pdf" &&
					file !== "pick-list.pdf",
			);

		console.log(`找到 ${pdfFiles.length} 个PDF文件`);

		const mergedDoc = await PDFLibDocument.create();

		for (const upc of upcUniqueList) {
			if (!upcPageRanges[upc]) continue;
			const upcInfo = upcPageRanges[upc];
			const filePrefix = upcInfo.filePrefix;

			console.log(`处理UPC: ${upc} (文件前缀: ${filePrefix})`);

			const coverPath = path.join(
				folderPath,
				`cover-${filePrefix}.pdf`,
			);
			if (fs.existsSync(coverPath)) {
				console.log(`  添加Cover页: ${coverPath}`);
				const coverBytes = await readFile(coverPath);
				const coverDoc = await PDFLibDocument.load(coverBytes);
				const [coverPage] = await mergedDoc.copyPages(coverDoc, [0]);
				mergedDoc.addPage(coverPage);
			}

			const upcPdfFiles = (upcInfo.orderedPdfFiles || []).filter((file) =>
				pdfFiles.includes(file),
			);
			console.log(`  找到 ${upcPdfFiles.length} 个面单文件`);


			for (const pdfFile of upcPdfFiles) {
				const pdfPath = path.join(folderPath, pdfFile);
				console.log(`    添加面单: ${pdfFile}`);
				const pdfBytes = await readFile(pdfPath);
				const pdfDoc = await PDFLibDocument.load(pdfBytes);
				const pageCount = pdfDoc.getPageCount();

				for (let i = 0; i < pageCount; i++) {
					const [page] = await mergedDoc.copyPages(pdfDoc, [i]);
					mergedDoc.addPage(page);
				}
			}
		}

		const pickListPath = path.join(folderPath, "pick-list.pdf");
		if (fs.existsSync(pickListPath)) {
			console.log(`添加拣货单: ${pickListPath}`);
			const pickListBytes = await readFile(pickListPath);
			const pickListDoc = await PDFLibDocument.load(pickListBytes);
			const pickListPageCount = pickListDoc.getPageCount();

			for (let copy = 0; copy < 2; copy++) {
				for (let i = 0; i < pickListPageCount; i++) {
					const [page] = await mergedDoc.copyPages(pickListDoc, [i]);
					mergedDoc.addPage(page);
				}
			}
		}

		console.log(`合成文档共有 ${mergedDoc.getPageCount()} 页`);

		const mergedPath = path.join(folderPath, "merged.pdf");
		const mergedBytes = await mergedDoc.save();
		await writeFile(mergedPath, mergedBytes);

		console.log(`已保存合成文件: ${mergedPath}`);

		const allPdfFiles = fs
			.readdirSync(folderPath)
			.filter((file) => file.endsWith(".pdf"));

		console.log(`删除中间文件...`);
		for (const pdfFile of allPdfFiles) {
			if (pdfFile !== "merged.pdf") {
				const pdfPath = path.join(folderPath, pdfFile);
				fs.unlinkSync(pdfPath);
			}
		}

		console.log(`PDF 合成完成: ${mergedPath}`);
	} catch (error) {
		console.error(`PDF 合成失败:`, error.message);
		console.error(error.stack);
	}
}

async function processSingleBatch(batchItem, batchFolder, showJson) {
	console.log(`\n处理single批次: ${batchFolder}`);

	if (fs.existsSync(batchFolder)) {
		const existingFiles = fs.readdirSync(batchFolder);
		for (const file of existingFiles) {
			const filePath = path.join(batchFolder, file);
			fs.unlinkSync(filePath);
		}
		console.log(`已清空文件夹: ${batchFolder}`);
	} else {
		fs.mkdirSync(batchFolder, { recursive: true });
	}

	const jsonFilePath = path.join(batchFolder, "order.json");
	if (showJson) {
		const jsonContent = JSON.stringify(batchItem, null, 2);
		fs.writeFileSync(jsonFilePath, jsonContent, "utf8");
		console.log(`已保存 JSON 文件: ${jsonFilePath}`);
	} else {
		if (fs.existsSync(jsonFilePath)) {
			fs.unlinkSync(jsonFilePath);
		}
	}

	generatePickList(batchItem, batchFolder);

	const upcPageRanges = {};
	const processedOrders = new Set();

	for (let upcIndex = 0; upcIndex < batchItem.upcUniqueList.length; upcIndex++) {
		const upc = batchItem.upcUniqueList[upcIndex];
		const upcOrders = batchItem.orders[upcIndex] || [];
		
		if (upcOrders.length === 0) continue;
		
		const sanitizedUpc = sanitizeFileName(upc);
		const prefix = `u${upcIndex.toString().padStart(3, "0")}`;
		const filePrefix = `${prefix}_${sanitizedUpc}`;
		const actualUpcOrders = [];
		const orderedPdfFiles = [];
		
		for (const order of upcOrders) {

			if (processedOrders.has(order.orderNo)) {
				continue;
			}
			actualUpcOrders.push(order);
			processedOrders.add(order.orderNo);
		}

		for (const [orderPosition, order] of actualUpcOrders.entries()) {
			const orderPrefix = String(orderPosition + 1).padStart(3, "0");
			const labelFileName = `${filePrefix}_${orderPrefix}_${order.orderNo}.pdf`;
			const labelFilePath = path.join(batchFolder, labelFileName);
			orderedPdfFiles.push(labelFileName);

			try {
				console.log(`正在下载: ${order.expressLabelUrl}`);
				await downloadFile(order.expressLabelUrl, labelFilePath);
				console.log(`下载完成: ${labelFilePath}`);
			} catch (error) {
				console.error(
					`下载失败 ${order.expressLabelUrl}:`,
					error.message,
				);
			}
		}

		upcPageRanges[upc] = {


			start: 0,
			end: 0,
			sanitized: sanitizedUpc,
			prefix: prefix,
			filePrefix: filePrefix,
			count: actualUpcOrders.length,
			orderedPdfFiles,
		};


		if (actualUpcOrders.length > 0) {
			const coverPath = path.join(
				batchFolder,
				`cover-${filePrefix}.pdf`,
			);
			generateCoverPage(upc, actualUpcOrders.length, coverPath);
		}
	}

	await mergePDFs(batchFolder, batchItem, upcPageRanges, batchItem.upcUniqueList);
}

async function processMultipleBatch(batchItem, batchFolder, showJson) {
	console.log(`\n处理multiple批次: ${batchFolder}`);

	if (fs.existsSync(batchFolder)) {
		const existingFiles = fs.readdirSync(batchFolder);
		for (const file of existingFiles) {
			const filePath = path.join(batchFolder, file);
			fs.unlinkSync(filePath);
		}
		console.log(`已清空文件夹: ${batchFolder}`);
	} else {
		fs.mkdirSync(batchFolder, { recursive: true });
	}

	const jsonFilePath = path.join(batchFolder, "order.json");
	if (showJson) {
		const jsonContent = JSON.stringify(batchItem, null, 2);
		fs.writeFileSync(jsonFilePath, jsonContent, "utf8");
		console.log(`已保存 JSON 文件: ${jsonFilePath}`);
	} else {
		if (fs.existsSync(jsonFilePath)) {
			fs.unlinkSync(jsonFilePath);
		}
	}

	generatePickList(batchItem, batchFolder);

	const upcPageRanges = {};
	const processedOrders = new Set();
	const processedUpcList = [];

	for (let upcIndex = 0; upcIndex < batchItem.upcUniqueList.length; upcIndex++) {
		const upcOrders = batchItem.orders[upcIndex] || [];
		if (upcOrders.length === 0) continue;

		const groupedOrders = splitMultipleOrdersByExactSku(upcOrders);

		for (const [groupIndex, groupedOrder] of groupedOrders.entries()) {
			const combinedUpc = groupedOrder.skuLines.join("");
			const sanitizedUpc = sanitizeFileName(combinedUpc || groupedOrder.signature);
			const prefix = `u${upcIndex.toString().padStart(3, "0")}g${groupIndex.toString().padStart(2, "0")}`;
			const filePrefix = `${prefix}_${sanitizedUpc}`;
			const actualUpcOrders = [];
			const orderedPdfFiles = [];
			const rangeKey = `${prefix}::${groupedOrder.signature}`;

			for (const order of groupedOrder.orders) {
				if (processedOrders.has(order.orderNo)) {
					continue;
				}
				actualUpcOrders.push(order);
				processedOrders.add(order.orderNo);
			}

			for (const [orderPosition, order] of actualUpcOrders.entries()) {
				const orderPrefix = String(orderPosition + 1).padStart(3, "0");
				const labelFileName = `${filePrefix}_${orderPrefix}_${order.orderNo}.pdf`;
				const labelFilePath = path.join(batchFolder, labelFileName);
				orderedPdfFiles.push(labelFileName);

				try {
					console.log(`正在下载: ${order.expressLabelUrl}`);
					await downloadFile(order.expressLabelUrl, labelFilePath);
					console.log(`下载完成: ${labelFilePath}`);
				} catch (error) {
					console.error(
						`下载失败 ${order.expressLabelUrl}:`,
						error.message,
					);
				}
			}

			upcPageRanges[rangeKey] = {
				start: 0,
				end: 0,
				sanitized: sanitizedUpc,
				prefix: prefix,
				filePrefix: filePrefix,
				count: actualUpcOrders.length,
				orderedPdfFiles,
			};

			processedUpcList.push(rangeKey);

			if (actualUpcOrders.length > 0) {
				const coverPath = path.join(
					batchFolder,
					`cover-${filePrefix}.pdf`,
				);
				generateCoverPage(groupedOrder.skuLines, actualUpcOrders.length, coverPath);
			}
		}
	}

	await mergePDFs(batchFolder, batchItem, upcPageRanges, processedUpcList);
}

function printOptimizationStats(stats) {
	for (const type of ["single", "multiple"]) {
		const item = stats?.[type];
		if (!item) continue;
		console.log(`\n[${type}]`);
		console.log(`- 原批次数: ${item.originalBatchCount}`);
		console.log(`- 优化后批次数: ${item.optimizedBatchCount}`);
		console.log(`- UPC组数: ${item.groupCount}`);
		console.log(`- zone切换次数: ${item.totalZoneSwitches}`);
		console.log(`- shelf切换次数: ${item.totalShelfSwitches}`);
		console.log(`- 拣货明细行数: ${item.totalItems}`);
	}
}

async function processOrders() {
	const args = process.argv.slice(2);

	if (args.length < 1) {
		console.error(
			"使用方法: node process-ordersV4.js <json文件> [输出文件夹名] [-JSON=true] [--box-size=15] [--skip-optimize]",
		);
		process.exit(1);
	}

	const jsonFilePath = args[0];
	let outputDir = "output";
	let showJson = false;
	let shouldOptimize = true;
	let boxSize = DEFAULT_OPTIMIZE_BOX_SIZE;

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-JSON=true") {
			showJson = true;
		} else if (arg === "--skip-optimize") {
			shouldOptimize = false;
		} else if (arg.startsWith("--box-size=")) {
			const value = Number(arg.split("=")[1]);
			if (!Number.isFinite(value) || value <= 0) {
				console.error("--box-size 必须是正整数");
				process.exit(1);
			}
			boxSize = Math.floor(value);
		} else {
			outputDir = arg;
		}
	}

	if (!fs.existsSync(jsonFilePath)) {
		console.error(`文件不存在: ${jsonFilePath}`);
		process.exit(1);
	}

	const rawJsonData = JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));
	const optimizationResult = shouldOptimize
		? optimizePickingData(rawJsonData, boxSize)
		: null;
	const jsonData = optimizationResult?.optimizedData || rawJsonData;

	if (optimizationResult) {
		fs.writeFileSync(jsonFilePath, JSON.stringify(jsonData, null, 2), "utf8");
		console.log("=== 已先执行拣货批次优化 ===");
		console.log(`每批最大聚合后UPC数: ${boxSize}`);

		console.log(`优化后的 JSON 已覆盖原文件: ${jsonFilePath}`);
		printOptimizationStats(optimizationResult.stats);
	}

	if (!fs.existsSync(outputDir)) {

		fs.mkdirSync(outputDir, { recursive: true });
	}

	console.log("\n=== 开始处理订单 ===");

	for (const type of ["single", "multiple"]) {
		if (jsonData[type]) {
			const typeFolder = path.join(outputDir, type);
			if (!fs.existsSync(typeFolder)) {
				fs.mkdirSync(typeFolder);
			}

			for (let i = 0; i < jsonData[type].length; i++) {
				const batchItem = jsonData[type][i];
				const batchFolder = path.join(typeFolder, `Batch_${i + 1}`);
				if (type === "single") {
					await processSingleBatch(batchItem, batchFolder, showJson);
				} else {
					await processMultipleBatch(
						batchItem,
						batchFolder,
						showJson,
					);
				}
			}
		}
	}

	console.log(`\n所有处理完成！输出目录: ${outputDir}`);
}

if (require.main === module) {
	processOrders().catch(console.error);
}

module.exports = {
	processOrders,
};

