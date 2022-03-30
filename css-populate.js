#!/usr/bin/env node

'use strict'

import fs from "fs";
import yargs from 'yargs'
import {hideBin} from "yargs/helpers";
import fetch from 'node-fetch';
import * as N3 from 'n3'
const { namedNode, literal } = N3.DataFactory;

const argv = yargs(hideBin(process.argv))
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
        // demandOption: true
    })
    .option('generated', {
        alias: 'g',
        type: 'string',
        description: 'Dir with the generated data',
        demandOption: true
    })
    .help()
    .parseSync();

const cssBaseUrl = argv.url.endsWith('/') ? argv.url : argv.url+'/';
const cssDataDir = argv.data.endsWith('/') ? argv.data : argv.data+'/';
const generatedDataBaseDir = argv.generated.endsWith('/') ? argv.generated : argv.generated+'/';


const prefixes = {
    foaf: "http://xmlns.com/foaf/0.1/",
    solid: "http://www.w3.org/ns/solid/terms#",
    vcard: "http://www.w3.org/2006/vcard/ns#",
}

const uriBase = 'http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0';

/**
 *
 * @param {string} nameValue The name used to create the pod (same value as you would give in the register form online)
 */
async function createPod(nameValue) {
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


async function readAndParseInfo(genDataDir, file, pers) {

    const store = await readIntoStore(genDataDir+file);
    let info = await parseInfo(pers, store);

    return info;
}


async function readIntoStore(filepath) {
    const parser = new N3.Parser({ blankNodePrefix: '' });  // See https://github.com/rdfjs/N3.js/issues/183. Only needed if calling parse() multiple times for different parts of the same file.
    const store = new N3.Store();

    var data = fs.readFileSync(filepath, 'utf8').toString();
    let quads = parser.parse(data);
    store.addQuads(quads);

    return store;
}

async function parseInfo(pers, store) {

    let info = await getPersonInfo(store, uriBase, pers);
    let [id, firstName, lastName] = info;

    if (!id || !firstName || !lastName) {
        return null;
    }

    let friendList = await getFriendList(store, uriBase, pers);

    return [{id, firstName, lastName}, friendList];

}

async function getPersonInfo(store, uriBase, pers) {
    //    //examples:
    //    //<http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/data/pers00000000000000000065> <http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/vocabulary/id> "65"^^<http://www.w3.org/2001/XMLSchema#long> 
    //    //<http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/data/pers00000000000000000065> <http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/vocabulary/firstName> "Marc" .
    //    //<http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/data/pers00000000000000000065> <http://localhost:3000/www.ldbc.eu/ldbc_socialnet/1.0/vocabulary/lastName> "Ravalomanana" .
    const uriPerson = `${uriBase}/data/${pers}`;
    const uriId = `${uriBase}/vocabulary/id`;
    const uriFirstName = `${uriBase}/vocabulary/firstName`;
    const uriLastName = `${uriBase}/vocabulary/lastName`;
    let id, firstName, lastName;
    for (const quad of store.readQuads(namedNode(uriPerson), namedNode(uriId), null)) {
        if (id) {
            console.error("Person has two IDs!")
        }
        id = quad.object.value;
    }
    for (const quad of store.readQuads(namedNode(uriPerson), namedNode(uriFirstName), null)) {
        if (firstName) {
            console.error("Person has two firstNames!")
        }
        firstName = quad.object.value;
    }
    for (const quad of store.readQuads(namedNode(uriPerson), namedNode(uriLastName), null)) {
        if (lastName) {
            console.error("Person has two lastNames!")
        }
        lastName = quad.object.value;
    }
    return [id, firstName, lastName];
}

async function getFriendList(store, uriBase, pers) {
    const uriPerson = `${uriBase}/data/${pers}`;
    const uriKnows = `${uriBase}/vocabulary/knows`;
    const uriHasPerson = `${uriBase}/vocabulary/hasPerson`;
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

async function mergeProfileAndInfo(storeProfile, persInfo, account) {
    const uriAccount = `${cssBaseUrl}${account}/profile/card#me`;
    const vcardName = `${prefixes.vcard}fn`;
    const {id, firstName, lastName} = persInfo;
    const name = `${firstName} ${lastName}`;
    storeProfile.addQuad(namedNode(uriAccount), namedNode(vcardName), literal(name));
}

async function mergeProfileAndFriends(storeProfile, account, friends, persUserMap) {
    const uriAccount = `${cssBaseUrl}${account}/profile/card#me`;
    const foafKnows = `${prefixes.foaf}knows`;
    for (const friendNodeStr of friends) {
        try {
            const persFriend = friendNodeStr.split('/').pop();
            const {account:accountFriend} = persUserMap.get(persFriend);
            const uriFriendProfile = `${cssBaseUrl}${accountFriend}/profile/card#me`;
            storeProfile.addQuad(namedNode(uriAccount), namedNode(foafKnows), namedNode(uriFriendProfile));
        } catch (error) {
            console.error(error);
        }
    }
}

async function writeProfile(storeProfile, fileProfile) {
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

async function updateProfiles(genDataDir, persUserMap) {
    for (const [pers, {account, file}] of persUserMap) {
        try {
            const info = await readAndParseInfo(genDataDir, file, pers);
            if (!info)
                continue;
            const [persInfo, friends] = info;
            const fileProfile = `${cssDataDir}${account}/profile/card$.ttl`;
            const storeProfile = await readIntoStore(fileProfile);
            await mergeProfileAndInfo(storeProfile, persInfo, account);
            await mergeProfileAndFriends(storeProfile, account, friends, persUserMap)
            await writeProfile(storeProfile, fileProfile);
        } catch (error) {
            console.error(error);
        }
    }
}

async function initUserPod(genDataDir, account, file) {
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

    // const podFile = `${podDir}/${file}`;
    const podFile = `${podDir}/person.nq`;
    fs.copyFileSync(genDataDir+file, podFile);
    console.log(`   cp ${genDataDir+file} ${podFile}`);

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

//Example person file:
//  /users/wvdemeer/pod-generator/out-fragments/http/localhost_3000/www.ldbc.eu/ldbc_socialnet/1.0/data/pers*.nq
async function main() {
    const genDataDir = generatedDataBaseDir+"out-fragments/http/localhost_3000/www.ldbc.eu/ldbc_socialnet/1.0/data/"
    const files = fs.readdirSync(genDataDir);
    let persUserMap = new Map();
    let curIndex = 0;
    for (const file of files) {
        if (file.startsWith("pers") && file.endsWith(".nq")) {
            const pers = file.substring(0, file.length-3);
            const persIndex = curIndex++;
            console.log(`file=${file} pers=${pers} persIndex=${persIndex}`);

            //const fileBaseName = path.basename(file);
            // const account = `${firstName}${id}`.replace(/[^A-Za-z0-9]/, '');
            const account = `user${persIndex}`;

            await initUserPod(genDataDir, account, file);

            persUserMap.set(pers, {account, file});
        }
    }

    await updateProfiles(genDataDir, persUserMap);
}
//require.main === module only works for CommonJS, not for ES modules in Node.js
//(though on my test system with node v15.14.0 it works, and on another system with node v17.5.0 it doesn't)
//so we will simply not check. That means you don't want to import this module by mistake.
// if (require.main === module) {
    try {
        await main(process.argv[2], process.argv[3]);
        // process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
// }
