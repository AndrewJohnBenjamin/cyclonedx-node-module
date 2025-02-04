const readInstalled = require("read-installed");
const parsePackageJsonName = require("parse-packagejson-name");
const ssri = require("ssri");
const spdxLicenses = require("./spdx-licenses.json");
const fs = require('fs');
const uuidv4 = require('uuid/v4');

/**
 * Performs a lookup + validation of the license specified in the
 * package. If the license is a valid SPDX license ID, set the 'id'
 * of the license object, otherwise, set the 'name' of the license
 * object.
 */
function getLicenses(schemaVersion, pkg) {
    let license = pkg.license && (pkg.license.type || pkg.license);
    if (license) {
        if (!Array.isArray(license)) {
            license = [license];
        }
        return license.map(l => {
            let licenseContent = {};
            if (spdxLicenses.some(v => { return l === v; })) {
                licenseContent.id = l;
            } else {
                licenseContent.name = l;
            }
            if (schemaVersion !== "1.0") {
                addLicenseText(pkg, l, licenseContent);
            }
            return licenseContent;
        }).map(l => ({license: l}));
    }
    return [ { license: {} }];
}

/**
 * Tries to find a file containing the license text based on commonly
 * used naming and content types. If a candidate file is found, add
 * the text to the license text object and stop.
 */
function addLicenseText(pkg, l, licenseContent) {
    let licenseFilenames = [ 'LICENSE', 'LICENCE', 'License', 'Licence', 'NOTICE', 'Notice' ];
    let licenseContentTypes = { "text/plain": '', "text/txt": '.txt', "text/markdown": '.md', "text/xml": '.xml' };
    /* Loops over different name combinations starting from the license specified
       naming (e.g., 'LICENSE.Apache-2.0') and proceeding towards more generic names. */
    for (const licenseName of [`.${l}`, '']) {
        for (const licenseFilename of licenseFilenames) {
            for (const [licenseContentType, fileExtension] of Object.entries(licenseContentTypes)) {
                let licenseFilepath = `${pkg.realPath}/${licenseFilename}${licenseName}${fileExtension}`;
                if (fs.existsSync(licenseFilepath)) {
                    licenseContent.text = readLicenseText(licenseFilepath, licenseContentType);
                    return;
                }
            }
        }
    }
}

/**
 * Read the file from the given path to the license text object and includes
 * content-type attribute, if not default. Returns the license text object.
 */
function readLicenseText(licenseFilepath, licenseContentType) {
    let licenseContentText = { value : "<![CDATA[" + "\n" + fs.readFileSync(licenseFilepath) + "]]>"};
    if (licenseContentType !== "text/plain") {
        licenseContentText["@content-type"] = licenseContentType;
    }
    return licenseContentText;
}

/**
 * For all modules in the specified package, creates a list of
 * component objects from each one.
 */
exports.listComponents = listComponents;
function listComponents(schemaVersion, pkg) {
    let list = {};
    let isRootPkg = true;
    addComponent(schemaVersion, pkg, list, isRootPkg);
    return Object.keys(list).map(k => ({ component: list[k] }));
}

/**
 * Given the specified package, create a CycloneDX component and add it to the list.
 */
function addComponent(schemaVersion, pkg, list, isRootPkg = false) {
    //read-installed with default options marks devDependencies as extraneous
    //if a package is marked as extraneous, do not include it as a component
    if(pkg.extraneous) return;
    if(!isRootPkg) {
        let pkgIdentifier = parsePackageJsonName(pkg.name);
        let group = pkgIdentifier.scope;
        let name = pkgIdentifier.fullName;
        let purlName = pkg.name.replace("@", "%40"); // Encode 'scoped' npm packages in purl
        let component = {
            "@type"     : determinePackageType(pkg),
            group       : group,
            name        : name,
            version     : pkg.version,
            description : `<![CDATA[${pkg.description}]]>`,
            hashes      : [],
            licenses    : getLicenses(schemaVersion, pkg),
            purl        : `pkg:npm/${purlName}@${pkg.version}`,
            modified    : false
        };

        if (group === null) {
            delete component.group; // If no group exist, delete it (it's optional)
        }

        if (schemaVersion !== "1.0") {
            // Delete this as it's required in v1.0 and optional in newer versions.
            // Pedigree is the suggested way to specify modifications in schema 1.1 and higher.
            delete component.modified;
        }

        processHashes(pkg, component);

        if (list[component.purl]) return; //remove cycles
        list[component.purl] = component;
    }
    if (pkg.dependencies) {
        Object.keys(pkg.dependencies)
            .map(x => pkg.dependencies[x])
            .filter(x => typeof(x) !== "string") //remove cycles
            .map(x => addComponent(schemaVersion, x, list));
    }
}

/**
 * Creates a child XML node.
 */
function createChild(name, value, depth) {
    if (name === "value") return value;
    if (Array.isArray(value)) return `<${name}>${value.map(v => js2Xml(v, depth + 1)).join('')}</${name}>`;
    if (['boolean', 'string', 'number'].includes(typeof value)) return `<${name}>${value}</${name}>`;
    if (['object'].includes(typeof value) && typeof value.type !== "undefined") return `<${name}>${value.type}</${name}>`;
    if (name === "text" && typeof value === "object") return js2Xml({ [name] : value }, depth);
    //console.log(name, value);
    throw new Error("Unexpected child: " + name + " " + (typeof value) );
}

/**
 * Converts the Javascript object to XML.
 */
function js2Xml(obj, depth) {
    return Object.keys(obj).map(key => {
        let attrs = Object.keys(obj[key])
            .filter(x => x.indexOf('@') === 0)
            .map(x => ` ${x.slice(1)}="${obj[key][x]}"`)
            .join('') || '';
        let children = Object.keys(obj[key])
            .filter(x => x.indexOf('@') === -1)
            .map(x => createChild(x, obj[key][x], depth + 1))
            .join('');
        return `<${key}${attrs}>${children}</${key}>`
    }).join("\n");
}

/**
 * If the author has described the module as a 'framework', the take their
 * word for it, otherwise, identify the module as a 'library'.
 */
function determinePackageType(pkg) {
    if (pkg.hasOwnProperty("keywords")) {
        for (keyword of pkg.keywords) {
            if (keyword.toLowerCase() === "framework") {
                return "framework";
            }
        }
    }
    return "library";
}

/**
 * Uses the SHA1 shasum (if present) otherwise utilizes Subresource Integrity
 * of the package with support for multiple hashing algorithms.
 */
function processHashes(pkg, component) {
    if (pkg._shasum) {
        component.hashes.push({ hash: { "@alg":"SHA-1", value: pkg._shasum} });
    } else if (pkg._integrity) {
        let integrity = ssri.parse(pkg._integrity);
        // Components may have multiple hashes with various lengths. Check each one
        // that is supported by the CycloneDX specification.
        if (integrity.hasOwnProperty("sha512")) {
            addComponentHash("SHA-512", integrity.sha512[0].digest, component);
        }
        if (integrity.hasOwnProperty("sha384")) {
            addComponentHash("SHA-384", integrity.sha384[0].digest, component);
        }
        if (integrity.hasOwnProperty("sha256")) {
            addComponentHash("SHA-256", integrity.sha256[0].digest, component);
        }
        if (integrity.hasOwnProperty("sha1")) {
            addComponentHash("SHA-1", integrity.sha1[0].digest, component);
        }
    }
    if (component.hashes.length === 0) {
        delete component.hashes; // If no hashes exist, delete the hashes node (it's optional)
    }
}

/**
 * Adds a hash to component.
 */
function addComponentHash(alg, digest, component) {
    let hash = Buffer.from(digest, "base64").toString("hex");
    component.hashes.push({hash: {"@alg": alg, value: hash}});
}

exports.createbom = (schemaVersion, includeBomSerialNumber, path, options, callback) => readInstalled(path, options, (err, pkgInfo) => {
    if (schemaVersion !== "1.0" && schemaVersion !== "1.1") {
        throw new Error("Unexpected schema version");
    }
	let result = { bom: {
		"@xmlns"  :"http://cyclonedx.org/schema/bom/" + schemaVersion,
		"@version": 1,
		components: listComponents(schemaVersion, pkgInfo)
	}};
	if (includeBomSerialNumber) {
        result.bom["@serialNumber"] = "urn:uuid:" + uuidv4();
    }
	callback(null, `<?xml version="1.0" encoding="UTF-8"?>\n${js2Xml(result,0)}`);
});
