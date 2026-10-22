> This is the earlier SDS-only guide. For this complete project folder, use [the current setup guide](../../docs/END_TO_END_SETUP.md).

# Add product safety data sheets to MR Brands

The updated code ZIP contains the complete existing project and an updated `data/seed/Mr_Brand_RAG_Updated.zip`. The companion `MR_Brands_SDS_Documents.zip` contains the original PDFs, searchable JSON copies, readable text copies and a searchable product index. No live database upload has been run.

## What has been prepared

| Item | Count |
|---|---:|
| Existing catalog products preserved | 89 |
| Products added from the SDS spreadsheet | 136 |
| Updated catalog products | 225 |
| Supplied SDS PDFs and searchable copies | 140 |
| SDS files linked for ingestion | 131 |
| SDS files pending review | 9, covering 5 products |
| Existing product manuals preserved | 110 |
| Existing policies preserved | 8 |

The filename is **products.json**, with an “s”. The existing 89 manual-based products did not have a matching SDS item in this upload. Their manuals and catalog records are preserved; no missing safety sheets have been invented.

“Simplified” means a searchable structure with product identity, source filename, source page numbers and extracted text. Safety wording, concentrations, instructions and conditions have not been shortened into new advice. JSON files are for ingestion. Markdown text files are for reading. Original PDFs retain pictograms and table layouts.

## 1. Put the updated files in your project

Extract the updated code ZIP. Use the project folder containing `package.json`. Keep your existing environment settings when updating your own installation.

The package includes these changes:

- `data/seed/Mr_Brand_RAG_Updated.zip`: updated `products.json`, existing manuals and policies, and the new `safety-data-sheets/` folder.
- `src/services/knowledge/documents/index.js`: reads `safetyDataSheetPaths`, identifies SDS documents and retains source page counts in JSON documents.
- `src/services/knowledge/ingestion/index.js`: validates exact product-to-SDS paths, ingests SDS as `safety_data_sheet` with product scope, and reports their count.
- `scripts/ingestKnowledge/index.js`: documents the SDS folder in CLI help.
- `src/models/knowledge/queries/index.js` and `src/common/rag/evidenceContext/index.js`: make SDS paths and UPCs available as product evidence.
- `src/lib/prompt/index.js`: tells the bot to respect the source substance/component scope and avoid combining conflicting versions.

All seed files are included in the download. If your deployment workflow excludes `data/seed/`, run ingestion locally or copy the seed ZIP to the environment where you run the command.

## 2. Install and check

Use Node.js 22 or 24. Run these from the project root:

```bash
npm ci
npm run check
```

## 3. Validate the complete MR Brands package

```bash
npm run ingest -- --source data/seed/Mr_Brand_RAG_Updated.zip --brand-key mr-brand --allow-missing-manuals --validate-only
```

This parses and checks the files without calling Voyage or Cosmos. Expected totals: **225 products, 110 manuals, 131 safety data sheets, 8 policies and 249 documents**.

`--allow-missing-manuals` is required because the 136 added products came from the SDS spreadsheet and do not have instruction manuals in the existing package. Exact SDS paths are still checked. An SDS is stored separately from an instruction manual.

## 4. Use your existing database settings

Your uploaded code uses **Voyage embeddings and Azure Cosmos DB**. It does not use the older Pinecone/Gemini ingestion flow.

The upload command needs your existing settings:

```dotenv
COSMOS_ENDPOINT=your_existing_endpoint
COSMOS_KEY=your_existing_key
VOYAGE_API_KEY=your_existing_key
```

Retain your existing `COSMOS_DATABASE_ID`, `COSMOS_CONTAINER_ID`, `VOYAGE_EMBEDDING_MODEL` and `RAG_VECTOR_DIMENSIONS` values. The code defaults to database `zendesk-rag`, container `knowledge` and 1024 vector dimensions. The embedding output and container dimension must agree. Do not change the model or dimension just to add SDS documents.

## 5. Upload the knowledge package

Once validation passes and the existing settings are available, run:

```bash
npm run ingest -- --source data/seed/Mr_Brand_RAG_Updated.zip --brand-key mr-brand --allow-missing-manuals
```

This generates embeddings, writes product and document records to Cosmos, and activates a complete new knowledge snapshot for `mr-brand`. This is a full brand snapshot, so use the complete updated seed ZIP containing the existing manuals and policies. Uploading an SDS-only package as the full brand package would omit existing knowledge from the new active snapshot.

The final output should say `Knowledge snapshot ... is now active for mr-brand.` Save the ingestion summary from your environment. The prepared download has not performed this live step.

The separate `comfort-zone` seed ZIP is byte-for-byte unchanged. The two Comfort Zone-branded items in the supplied SDS spreadsheet were added to the parent `mr-brand` catalog, matching its existing portfolio scope. They will not appear in the separate `comfort-zone` knowledge partition unless you deliberately update and ingest that package too.

## 6. Deploy and check the bot

Deploy the changed application files through your normal deployment process, keeping the application's Cosmos settings pointed at the same database you used for ingestion. Restart the application if your deployment does not do that automatically.

Try these questions in the MR Brands widget:

- “Do you have product 01259?” The catalog should identify the supplied Simoniz protectant product.
- “What handling instructions are in the SDS for product 01259?” The answer should use that item's source evidence.
- “Which product has UPC 819772012599?” UPCs are stored as string aliases for product lookup.
- “What does the source sheet for CZ127612 cover?” The answer should identify the R32 refrigerant scope and avoid describing it as whole-appliance safety.
- “Give me the latest SDS for 32063.” The bot should not claim it has selected a current version while that item is pending.
- Ask a previous instruction-manual question for one of your original products to check that existing knowledge is still available.

## 7. Review the five pending products

Extract `MR_Brands_SDS_Documents.zip` and open `START_HERE.html`. Search by product ID, UPC, name or status. Each row links to the original PDF, searchable JSON and readable text.

| Product | Why it is pending | Required action |
|---|---|---|
| 01682 | Two supplied SDS versions | Confirm which source version applies to the product. |
| 01683 | Two supplied SDS versions | Confirm which source version applies to the product. |
| 32061 | Two supplied SDS versions; filename year and printed revision date do not establish the same ordering | Confirm the applicable source version. |
| 32063 | Two versions and a spreadsheet description conflict: 18oz versus 16oz | Confirm the package size and applicable source version. |
| CZ12570 | Scanned document requiring OCR review; its subject is a CR2025 button-cell component | Compare every OCR page with the original PDF and confirm the component association. |

These five products are present in `products.json`, with review notes and empty `safetyDataSheetPaths`. Their nine extracted files are in the companion package, outside the active seed. The other supplied filename typo, `32123 (20205)`, is retained in source metadata; the product ID is `32123`. A filename year has not been treated as an official revision date.

For an approved file:

1. Extract `data/seed/Mr_Brand_RAG_Updated.zip` into a working folder.
2. Copy the approved JSON from the companion `simplified/` folder into the seed's `safety-data-sheets/` folder. For OCR, correct and review the extracted content first.
3. Find that exact product in `products.json`. Set `safetyDataSheetPaths` to the exact relative JSON path, for example `safety-data-sheets/APPROVED_FILENAME.json`. Do not use this placeholder literally.
4. Update the product's `attributes.safetyDataSheetStatus` to describe the completed review. Keep a record of the approved PDF version and date. Do not activate two conflicting versions for the same product.
5. Re-ZIP the complete seed with `products.json` at the ZIP root. Replace the seed ZIP in `data/seed/`.
6. Repeat validation and then ingestion from steps 3 and 5.

## 8. Add more products later

Add a product record with a stable string ID and the supplied name. Keep leading zeroes in IDs and UPCs. Retain existing products when editing the catalog. Put its approved SDS JSON, PDF or text file in `safety-data-sheets/` and link its exact relative path in `safetyDataSheetPaths`.

```json
{
  "productId": "NEW_ITEM_ID",
  "productName": "Name from the supplied product source",
  "brand": "Brand from the supplied product source",
  "alternateProductIds": [],
  "manualPaths": [],
  "safetyDataSheetPaths": [
    "safety-data-sheets/NEW_ITEM_ID_SDS.json"
  ]
}
```

For extracted JSON, follow the supplied files: `documentType`, `documentScope`, `product`, `totalPages`, `source` and `sections`. Each section contains its source page number and text. For a scanned PDF, review the OCR copy before activating it; the Node importer does not run OCR itself. Leave unknown prices, warranties, ingredients and other unsupported product properties unset. Repeat the complete validation and ingestion steps after updating the seed.
