import fs from "fs";
import yargs from 'yargs'
import {hideBin} from "yargs/helpers";
import fetch from 'node-fetch';
import * as N3 from 'n3'
const { namedNode, literal } = N3.DataFactory;
import * as fse from 'fs-extra';

const argv = yargs(hideBin(process.argv))
    .command('ldbc', 'Populate with LDBC data.', (yargs) => {
        yargs
            .option('generated', {
                alias: 'g',
                type: 'string',
                description: 'Dir with the generated data',
                demandOption: true
            })
    })
    .command('full', 'Populate with full-connect data', (yargs) => {
        yargs
            .option('number', {
                alias: 'n',
                type: 'number',
                description: 'Number of accounts to generate',
                demandOption: true
            })
            .option('generated', {
                alias: 'g',
                type: 'string',
                description: 'Dir of the LDBC data; used to initialize user name',
                demandOption: false
            })
            .option('extra', {
                alias: 'e',
                type: 'string',
                description: 'Extra data to put into user pod. This should be a directory, whose contents are sub-dirs named with user names (user1, user2, etc).',
                demandOption: false
            })
    })
    .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Base URL of the CSS',
        demandOption: true
    })
    .option('data', {
        alias: 'd',
        type: 'string',
        description: 'Data dir of the CSS',
        demandOption: true
    })
    .help()
    .parseSync();

function dirStr(dir: string): string {
    return dir.endsWith('/') ? dir : dir+'/';
}
function maybeDirStr(maybeDir: string | undefined): string | undefined {
    return maybeDir ? dirStr(maybeDir) : undefined;
}

const command = argv._[0];

const cssBaseUrl = dirStr(argv.url);
const cssDataDir = dirStr(argv.data);

const extraDir = maybeDirStr(argv.extra as string | undefined);

const generatedDataBaseDir = maybeDirStr(argv.generated as string | undefined);

const uriBaseLDBC = 'http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0';

const prefixes = {
    foaf: "http://xmlns.com/foaf/0.1/",
    solid: "http://www.w3.org/ns/solid/terms#",
    vcard: "http://www.w3.org/2006/vcard/ns#",
}

interface PersonInfo {
    id: string,
    firstName: string,
    lastName: string
}

interface FriendList extends Array<string> {}

interface PersUserMap extends Map<string, {account: string, file: string}> {}

/**
 *
 * @param nameValue - The name used to create the pod (same value as you would give in the register form online)
 */
async function createPod(nameValue: string) {
    const settings =  {
        podName: nameValue,
        email: `${nameValue}@example.org`,
        password: 'password',
        confirmPassword: 'password',
        register: true,
        createPod: true,
        createWebId: true
    }

    //console.log('SETTINGS', settings)

    const res = await fetch(`${cssBaseUrl}idp/register/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(settings),
    });

    // console.log(`res.ok`, res.ok);
    // console.log(`res.status`, res.status);

    // See server response or error text
    let jsonResponse = await res.json();
    // console.log(`jsonResponse`, jsonResponse);

    if (jsonResponse.name && jsonResponse.name.includes('Error')) {
        console.error(`${jsonResponse.name} - Creating pod for ${nameValue} failed: ${jsonResponse.message}`);
    }
    // else {
        // console.log(`Pod for ${nameValue} created successfully`);
    // }
}


/**
 * Read and extract relevant information from generated LDBC data for a user.
 * Including user name, user ID and friends.
 * Friends are the original URIs in the original data.
 * The generated data is that created by https://github.com/rubensworks/ldbc-snb-decentralized.js.
 *
 * @param {string} genDataDir - The directory containing generated data
 * @param {string} file - The generated data file name
 * @param {string} pers - The person identifier of the person in this data.
 * @return {persInfo, friendList} - where
 *   persInfo = {id, firstName, lastName},
 *   friendList is an array of strings (friends URIs)
 *
 *
 * @example
 *
 *     persInfo, friends = readAndParseInfo("PATH", "file.nq", "pers00000001");
 */
async function readAndParseInfo(genDataDir: string, file: string, pers: string): Promise<[PersonInfo, FriendList] | null> {

    const store = await readIntoStore(genDataDir+file);
    let info = await parseInfo(pers, store);

    return info;
}


/**
 * Read the RDF document represented in the filepath into a {@link N3.Store}
 * TODO: optimise by using asynchronous methods or streaming methods.
 */
async function readIntoStore(filepath: string): Promise<N3.Store> {
    const parser = new N3.Parser({ blankNodePrefix: '' });  // See https://github.com/rdfjs/N3.js/issues/183. Only needed if calling parse() multiple times for different parts of the same file.
    const store = new N3.Store();

    var data = fs.readFileSync(filepath, 'utf8').toString();
    let quads = parser.parse(data);
    store.addQuads(quads);

    return store;
}


/**
 * Retrieve information from the quad store.
 * This is used within {@link readAndParseInfo()}, and is not expected to be used elsewhere.
 */
async function parseInfo(pers: string, store: N3.Store): Promise<[PersonInfo, FriendList] | null> {

    let info = await getPersonInfo(store, pers);
    let {id, firstName, lastName} = info;

    if (!id || !firstName || !lastName) {
        return null;
    }

    let friendList = await getFriendList(store, pers);

    return [{id, firstName, lastName}, friendList];

}

/**
 * Retrieve personal information from the quad store.
 * This is used within {@link readAndParseInfo()}, and is not expected to be used elsewhere.
 */
async function getPersonInfo(store: N3.Store, pers: string): Promise<PersonInfo>  {
    //    //examples:
    //    //<http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/data/pers00000000000000000065> <http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/vocabulary/id> "65"^^<http://www.w3.org/2001/XMLSchema#long> 
    //    //<http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/data/pers00000000000000000065> <http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/vocabulary/firstName> "Marc" .
    //    //<http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/data/pers00000000000000000065> <http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/vocabulary/lastName> "Ravalomanana" .
    const uriPerson = `${uriBaseLDBC}/data/${pers}`;
    const uriId = `${uriBaseLDBC}/vocabulary/id`;
    const uriFirstName = `${uriBaseLDBC}/vocabulary/firstName`;
    const uriLastName = `${uriBaseLDBC}/vocabulary/lastName`;
    let id, firstName, lastName;

    let one = (uriPredicate: string, type: string) => {
        let ret;
        for (const quad of store.readQuads(namedNode(uriPerson), namedNode(uriPredicate), null)) {
            if (ret) {
                console.error(`Person has two ${type}s!`)
            }
            ret = quad.object.value;
        }
        return ret;
    };
    id = one(uriId, "ID");
    firstName = one(uriFirstName, "firstName");
    lastName = one(uriLastName, "lastName");
    return {id, firstName, lastName};
}

/**
 * Retrieve friend list from the quad store.
 * This is used within {@link readAndParseInfo()}, and is not expected to be used elsewhere.
 */
async function getFriendList(store: N3.Store, pers: string): Promise<FriendList> {
    const uriPerson = `${uriBaseLDBC}/data/${pers}`;
    const uriKnows = `${uriBaseLDBC}/vocabulary/knows`;
    const uriHasPerson = `${uriBaseLDBC}/vocabulary/hasPerson`;
    let friends = [];
    for (const quad of store.readQuads(namedNode(uriPerson), namedNode(uriKnows), null)) {
        let friend;
        const obj = quad.object;
        for (const quadObj of store.readQuads(obj, namedNode(uriHasPerson), null)) {
            friend = quadObj.object.value;
            friends.push(friend);
        }
        if (!friend) {
            console.error("Friend node not exist", obj, pers)
        }
    }
    return friends;
}

/**
 * Merge the WebID profile and personal information.
 * This is used within {@link updateProfiles()}, and is not expected to be used elsewhere.
 */
async function mergeProfileAndInfo(storeProfile: N3.Store, persInfo: PersonInfo, account: string) {
    const uriAccount = `${cssBaseUrl}${account}/profile/card#me`;
    const vcardName = `${prefixes.vcard}fn`;
    const {id, firstName, lastName} = persInfo;
    const name = `${firstName} ${lastName}`;
    storeProfile.addQuad(namedNode(uriAccount), namedNode(vcardName), literal(name));
}

/**
 * Add the list of friends to the WebID profile.
 * This is used within {@link updateProfiles()}, and is not expected to be used elsewhere.
 *
 * @param {Map<string, {string, string>} persUserMap - The mapping from person ID to Pod information. Same as that used in {@link updateProfiles()}
 * TODO: Complete doc for the parameters.
 */
async function mergeProfileAndFriendsLDBC(storeProfile: N3.Store, account: string, friends: FriendList, persUserMap: PersUserMap) {
    const uriAccount = `${cssBaseUrl}${account}/profile/card#me`;
    const foafKnows = `${prefixes.foaf}knows`;
    for (const friendNodeStr of friends) {
        try {
            const persFriend = friendNodeStr.split('/').pop()!;
            const {account:accountFriend} = persUserMap.get(persFriend)!;
            const uriFriendProfile = `${cssBaseUrl}${accountFriend}/profile/card#me`;
            storeProfile.addQuad(namedNode(uriAccount), namedNode(foafKnows), namedNode(uriFriendProfile));
        } catch (error) {
            console.error(error);
        }
    }
}

async function addDummyFriends(account: string, friends: FriendList) {
    try {
        const fileProfile = `${cssDataDir}${account}/profile/card$.ttl`;
        const storeProfile = await readIntoStore(fileProfile);
        await mergeProfileAndFriends(storeProfile, account, friends)
        await writeProfile(storeProfile, fileProfile);
    } catch (error) {
        console.error(error);
    }
}

async function mergeProfileAndFriends(storeProfile: N3.Store, account: string, friends: FriendList) {
    const uriAccount = `${cssBaseUrl}${account}/profile/card#me`;
    const foafKnows = `${prefixes.foaf}knows`;
    for (const friendStr of friends) {
        try {
            let uriFriendProfile;
            if (friendStr.includes('https://')) {
                uriFriendProfile = friendStr;
            } else {
                uriFriendProfile = `${cssBaseUrl}${friendStr}/profile/card#me`;
            }
            storeProfile.addQuad(namedNode(uriAccount), namedNode(foafKnows), namedNode(uriFriendProfile));
        } catch (error) {
            console.error(error);
        }
    }
}

/**
 * Write the WebID profile (storeProfile) into the file (fileProfile)
 */
async function writeProfile(storeProfile: N3.Store, fileProfile: string): Promise<void> {
    const writer = new N3.Writer({ prefixes: prefixes });
    for (const quad of storeProfile) {
        if (quad.subject instanceof N3.DefaultGraph) {
            writer.addQuad(namedNode(quad.subject.value), quad.predicate, quad.object);
        } else {
            writer.addQuad(quad);
        }
    }
    return new Promise((resolve, reject) => {
        writer.end((error, result) => {
            fs.writeFileSync(fileProfile, result);
            resolve();
        });
    });
}

/**
 * Update the user profile from the generated (LDBC) person data.
 * User profiles (and thus pods) should be generated before calling this function.
 * This function will modify the users' WebID document (profile cards).
 *
 * @param {Map<string, {string, ...>} persUserMap - The mapping from person ID to Pod information:
 *     key: person ID, extracted from generated data;
 *     value: {account, ...} where account is the Pod account name, and the rest does not matter.
 * TODO: Complete doc for the parameters.
 */
async function updateProfile(genDataDir: string, pers: string, account: string, ldbcFile: string, persUserMap?: PersUserMap) {
    try {
        const info = await readAndParseInfo(genDataDir, ldbcFile, pers);
        if (!info)
            return;
        const [persInfo, friends] = info;
        const fileProfile = `${cssDataDir}${account}/profile/card$.ttl`;
        const storeProfile = await readIntoStore(fileProfile);
        await mergeProfileAndInfo(storeProfile, persInfo, account);
        if (persUserMap) {
            await mergeProfileAndFriendsLDBC(storeProfile, account, friends, persUserMap);
        }
        await writeProfile(storeProfile, fileProfile);
    } catch (error) {
        console.error(error);
    }
}

async function putIntoUserPod(account: string, baseDir: string) {
    const podDir = `${cssDataDir}${account}`;
    const contents = fse.readdirSync(baseDir);
    for (const content of contents) {
        const target = `${podDir}/${content}`;
        const source = `${baseDir}/${content}`;
        fse.copySync(source, target);

        let targetAcl, aclContent;
        if (fse.statSync(source).isDirectory()) {
            targetAcl = `${target}/.acl`;
            aclContent = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.

<#public>
    a acl:Authorization;
    acl:accessTo <./>;
    acl:agentClass foaf:Agent;
    acl:mode acl:Read.

<#owner>
    a acl:Authorization;
    acl:accessTo <./>;
    acl:default <./>;
    acl:agent <http://css:3000/${account}/profile/card#me>;
    acl:mode acl:Read, acl:Write, acl:Control.
`;
        } else {
            targetAcl = `${target}.acl`;
            aclContent = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.

<#public>
    a acl:Authorization;
    acl:accessTo <./${content}>;
    acl:agentClass foaf:Agent;
    acl:mode acl:Read.

<#owner>
    a acl:Authorization;
    acl:accessTo <./${content}>;
    acl:agent <http://css:3000/${account}/profile/card#me>;
    acl:mode acl:Read, acl:Write, acl:Control.
`;
        }
        fse.writeFileSync(targetAcl, aclContent);
    }
}

/**
 * Create and initialize the contents of a user pod.
 * It calls the user registration of CSS, and then puts the corresponding `person.nq` file under it (and its ACL).
 */
async function initUserPod(account: string, genDataDir?: string, ldbcPersFile?: string) {
    const podDir = `${cssDataDir}${account}`;
    try {
        await createPod(account);
    } catch (error) {
        console.error(error);
    }
    if (fs.existsSync(podDir)) {
        console.log(`Created pod for ${account}`);
    } else {
        console.log(`Failed to create pod for ${account}: dir ${podDir} does not exist!`);
        // continue;
        return;
    }

    if (ldbcPersFile) {
        // const podFile = `${podDir}/${file}`;
        const podFile = `${podDir}/person.nq`;
        fs.copyFileSync(genDataDir+ldbcPersFile, podFile);
        console.log(`   cp ${genDataDir+ldbcPersFile} ${podFile}`);

        const podFileAcl = `${podFile}.acl`;
        fs.writeFileSync(podFileAcl, `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.

<#public>
    a acl:Authorization;
    acl:accessTo <./person.nq>;
    acl:agentClass foaf:Agent;
    acl:mode acl:Read.

<#owner>
    a acl:Authorization;
    acl:accessTo <./person.nq>;
    acl:agent <http://css:3000/${account}/profile/card#me>;
    acl:mode acl:Read, acl:Write, acl:Control.
`);
        console.log(`   created ${podFileAcl}`);
    }
}

function bindLDBCWithAccount(genDataDir: string): PersUserMap {
    const files = fs.readdirSync(genDataDir);
    let persUserMap = new Map();
    let curIndex = 0;
    for (const file of files) {
        if (file.startsWith("pers") && file.endsWith(".nq")) {
            const pers = file.substring(0, file.length-3);
            const persIndex = curIndex++;

            //const fileBaseName = path.basename(file);
            // const account = `${firstName}${id}`.replace(/[^A-Za-z0-9]/, '');
            const account = `user${persIndex}`;

            persUserMap.set(pers, {account, file});
        }
    }
    return persUserMap;
}

//Example person file:
//  /users/wvdemeer/pod-generator/out-fragments/http/localhost_3000/www.ldbc.eu/ldbc_socialnet/1.0/data/pers*.nq
async function mainLDBC() {
    const genDataDir = generatedDataBaseDir+"out-fragments/http/localhost_3000/www.ldbc.eu/ldbc_socialnet/1.0/data/"
    const persUserMap = bindLDBCWithAccount(genDataDir);

    for (const [pers, {account, file}] of persUserMap) {
        console.log(`file=${file} pers=${pers} account=${account}`);
        await initUserPod(account, genDataDir, file);
        await updateProfile(genDataDir, pers, account, file, persUserMap);
    }
}

async function mainFull() {
    let accounts = [];
    let num = argv.number as number;
    for (let i = 0; i < num; i++) {
        const account = `user${i}`;
        accounts.push(account);
    }

    if (generatedDataBaseDir) {
        const genDataDir = generatedDataBaseDir+"out-fragments/http/localhost_3000/www.ldbc.eu/ldbc_socialnet/1.0/data/";
        const persUserMap = bindLDBCWithAccount(genDataDir);
        let i = 0;
        for (const [pers, {account, file}] of persUserMap) {
            if (i >= num)
                break;
            console.log(`file=${file} pers=${pers} account=${account}`);
            await initUserPod(account, genDataDir, file);
            await updateProfile(genDataDir, pers, account, file);
            await addDummyFriends(account, accounts.filter(ac => ac != account));
            if (extraDir) {
                const userExtra = `${extraDir}${account}`;
                await putIntoUserPod(account, userExtra);
            }
            i++;
        }
    } else {
        for (let i = 0; i < num; i++) {
            const account = accounts[i];
            await initUserPod(account);
            await addDummyFriends(account, accounts.filter(ac => ac != account));
            if (extraDir) {
                const userExtra = `${extraDir}${account}`;
                await putIntoUserPod(account, userExtra);
            }
        }
    }
}


async function main() {
    if (command == 'ldbc') {
        await mainLDBC();
    } else if (command == 'full') {
        await mainFull();
    } else {
        throw Error('Unknown command, and not handled by yargs');
    }
}
//require.main === module only works for CommonJS, not for ES modules in Node.js
//(though on my test system with node v15.14.0 it works, and on another system with node v17.5.0 it doesn't)
//so we will simply not check. That means you don't want to import this module by mistake.
// if (require.main === module) {
    try {
        await main();
        // process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
// }
