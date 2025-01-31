const fs = require("fs");
const axios = require("axios")

function currentDate() {
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const day = String(currentDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file));
}

function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sparToCanonical(rawItems, today) {
    const canonicalItems = [];
    for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i];
        canonicalItems.push({
            store: "spar",
            id: item.masterValues["code-internal"],
            name: item.masterValues.title + " " + item.masterValues["short-description"],
            price: item.masterValues.price,
            priceHistory: [{ date: today, price: item.masterValues.price }],
            unit: item.masterValues["short-description-3"]
        });
    }
    return canonicalItems;
}

function billaToCanonical(rawItems, today) {
    const canonicalItems = [];
    for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i];
        canonicalItems.push({
            store: "billa",
            id: item.data.articleId,
            name: item.data.name,
            price: item.data.price.final,
            priceHistory: [{ date: today, price: item.data.price.final }],
            unit: item.data.grammage
        });
    }
    return canonicalItems;
}

function hoferToCanonical(rawItems, today) {
    const canonicalItems = [];
    for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i];
        canonicalItems.push({
            store: "hofer",
            id: item.ProductId,
            name: item.ProductName,
            price: item.Price,
            priceHistory: [{ date: today, price: item.Price }],
            unit: `${item.Unit} ${item.UnitType}`
        });
    }
    return canonicalItems;
}

async function fetchHofer() {
    const BASE_URL = `https://shopservice.roksh.at`
    const CATEGORIES = BASE_URL + `/category/GetFullCategoryList/`
    const CONFIG = { headers: { authorization: null } }
    const ITEMS = BASE_URL + `/productlist/CategoryProductList`

    // fetch access token
    const token_data = { "OwnWebshopProviderCode": "", "SetUserSelectedShopsOnFirstSiteLoad": true, "RedirectToDashboardNeeded": false, "ShopsSelectedForRoot": "hofer", "BrandProviderSelectedForRoot": null, "UserSelectedShops": [] }
    const token = (await axios.post("https://shopservice.roksh.at/session/configure", token_data, { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' } })).headers['jwt-auth'];
    CONFIG.headers.authorization = "Bearer " + token;

    // concat all subcategories (categories.[i].ChildList)
    const categories = (await axios.post(CATEGORIES, {}, CONFIG)).data;
    const subCategories = categories.reduce((acc, category) => acc.concat(category.ChildList), []);

    let hoferItems = [];
    for (let subCategory of subCategories) {
        let categoryData = (await axios.get(`${ITEMS}?progId=${subCategory.ProgID}&firstLoadProductListResultNum=4&listResultProductNum=24`, CONFIG)).data;
        const numPages = categoryData.ProductListResults[0].ListContext.TotalPages;

        for (let iPage = 1; iPage <= numPages; iPage++) {
            let items = (await axios.post(`${BASE_URL}/productlist/GetProductList`, { CategoryProgId: subCategory.ProgID, Page: iPage }, CONFIG)).data;
            hoferItems = hoferItems.concat(items.ProductList);
        }
    }

    return hoferItems;
}

function mergePriceHistory(oldItems, items) {
    if (oldItems == null) return items;

    const lookup = {}
    for (oldItem of oldItems) {
        lookup[oldItem.id] = oldItem;
    }

    for (item of items) {
        let oldItem = lookup[item.id];
        let currPrice = item.priceHistory[0];
        if (oldItem) {
            if (oldItem.priceHistory[0].price == currPrice.price) {
                item.priceHistory = oldItem.priceHistory;
                continue;
            }

            for (oldPrice of oldItem.priceHistory) {
                item.priceHistory.push(oldPrice);
            }
        }
    }

    return items;
}

/// Given a directory of raw data of the form `billa-$date.json` and `spar-$date.json`, constructs
/// a canonical list of all products and their historical price data.
function replay(rawDataDir) {
    const today = currentDate();

    const files = fs.readdirSync(rawDataDir).filter(
        file => file.indexOf("canonical") == -1 && (file.indexOf("billa-") == 0 || file.indexOf("spar") == 0)
    );

    const dateSort = (a, b) => {
        const dateA = new Date(a.match(/\d{4}-\d{2}-\d{2}/)[0]);
        const dateB = new Date(b.match(/\d{4}-\d{2}-\d{2}/)[0]);
        return dateA - dateB;
    };
    const sparFiles = files.filter(file => file.indexOf("spar-") == 0).sort(dateSort).map(file => rawDataDir + "/" + file);
    const sparFilesCanonical = sparFiles.map(file => sparToCanonical(readJSON(file), file.match(/\d{4}-\d{2}-\d{2}/)[0]));
    const billaFiles = files.filter(file => file.indexOf("billa-") == 0).sort(dateSort).map(file => rawDataDir + "/" + file);
    const billaFilesCanonical = billaFiles.map(file => billaToCanonical(readJSON(file), file.match(/\d{4}-\d{2}-\d{2}/)[0]));

    const allFilesCanonical = [];
    for (let i = 0; i < sparFilesCanonical.length; i++) {
        allFilesCanonical.push([...sparFilesCanonical[i], ...billaFilesCanonical[i]]);
    }

    if (allFilesCanonical.length == 0) return null;
    if (allFilesCanonical.length == 1) return allFilesCanonical[0];

    let prev = allFilesCanonical[0];
    let curr = null;
    for (let i = 1; i < allFilesCanonical.length; i++) {
        curr = allFilesCanonical[i];
        mergePriceHistory(prev, curr);
        prev = curr;
    }
    return curr;
}

const HITS = Math.floor(30000 + Math.random() * 2000);
const SPAR_SEARCH = `https://search-spar.spar-ics.com/fact-finder/rest/v4/search/products_lmos_at?query=*&q=*&page=1&hitsPerPage=${HITS}`;
const BILLA_SEARCH = `https://shop.billa.at/api/search/full?searchTerm=*&storeId=00-10&pageSize=${HITS}`;

exports.updateData = async function (dataDir) {
    const today = currentDate();
    console.log("Fetching data for date: " + today);

    let start = performance.now();
    const sparItems = (await axios.get(SPAR_SEARCH)).data.hits;
    fs.writeFileSync(`${dataDir}/spar-${today}.json`, JSON.stringify(sparItems, null, 2));
    const sparItemsCanonical = sparToCanonical(sparItems, today);
    console.log("Fetched SPAR data, took " + (performance.now() - start) / 1000 + " seconds");

    start = performance.now();
    const billaItems = (await axios.get(BILLA_SEARCH)).data.tiles;
    fs.writeFileSync(`${dataDir}/billa-${today}.json`, JSON.stringify(billaItems, null, 2));
    const billaItemsCanonical = billaToCanonical(billaItems, today);
    console.log("Fetched BILLA data, took " + (performance.now() - start) / 1000 + " seconds");

    start = performance.now();
    const hoferItems = await fetchHofer();
    fs.writeFileSync(`${dataDir}/hofer-${today}.json`, JSON.stringify(hoferItems, null, 2));
    const hoferItemsCanonical = hoferToCanonical(hoferItems, today);
    console.log("Fetched HOFER data, took " + (performance.now() - start) / 1000 + " seconds");

    const items = [...billaItemsCanonical, ...sparItemsCanonical, ...hoferItemsCanonical];
    if (fs.existsSync(`${dataDir}/latest-canonical.json`)) {
        const oldItems = JSON.parse(fs.readFileSync(`${dataDir}/latest-canonical.json`));
        mergePriceHistory(oldItems, items);
        console.log("Merged price history");
    }
    fs.writeFileSync(`${dataDir}/latest-canonical.json`, JSON.stringify(items, null, 2));

    return items;
}

/*(async () => {
    writeJSON("data/latest-canonical.json", replay("data"));
    await updateData("data");

    const today = currentDate();
    const items = readJSON("data/latest-canonical.json");
    for (item of items) {
        if (item.priceHistory[0].date == today && item.priceHistory.length > 1) {
            console.log(`${item.store} ${item.name} ${item.priceHistory[1].price} -> ${item.priceHistory[0].price}`);
        }
    }
})();*/
