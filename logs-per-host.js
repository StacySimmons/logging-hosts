const https = require('https');
const readline = require('readline')

const INTRO_TEXT = `We'll put some intro text here later.`

const REGIONS = {
    'us': 'https://api.newrelic.com/graphql',
    'eu': 'https://api.eu.newrelic.com/graphql'
};

let NERDGRAPH_URL = REGIONS['us'];
let USER_API_KEY = undefined;

const CERT_ERROR_HELP = `
Uh oh, I think you're behind an HTTPS proxy with a self-signed or internal
certificate, which can cause Node.js requests to the New Relic API to fail.
CAUTION: Someone could be maliciously intercepting your network traffic.
If you're sure this is a trusted proxy, you can work around this issue
in two ways:
1. Recommended: Set NODE_EXTRA_CA_CERTS environment variable to reference
a PEM file containing your proxy's certificate chain:
\tNODE_EXTRA_CA_CERTS=proxy-ca-root-cert.pem node nr-find-log4j.js
2. Unadvisable: Set NODE_TLS_REJECT_UNAUTHORIZED=0 environment variable to
disable SSL certificate validation.
See the Node.js docs for help: https://nodejs.org/api/cli.html
`;

const STATE = {
    apiKey: undefined,
    accountIds: undefined,
    region: 'us'
};

let state = STATE;

const QUERIES = {
    accessibleAccounts: `query getAccounts {
        actor {
          accounts {
            id
            name
          }
        }
      }`,
    getXstoreEntities: `query getXstoreEntities {
          actor {
            entitySearch(queryBuilder: {domain: INFRA, tags: {key: "team", value: "Xstore"}}) {
              count
              results {
                nextCursor
                entities {
                  ... on InfrastructureHostEntityOutline {
                    guid
                    name
                    accountId
                    reporting
                  }
                }
              }
            }
          }
        }`,
    getMoreXstoreEntities: `query getMoreXstoreEntities($cursor:String!) {
          actor {
            entitySearch(queryBuilder: {domain: INFRA, tags: {key: "team", value: "Xstore"}}) {
              count
              results(cursor: $cursor) {
                nextCursor
                entities {
                  ... on InfrastructureHostEntityOutline {
                    guid
                    name
                    accountId
                    reporting
                  }
                }
              }
            }
          }
        }`,
    getLogHosts: `query getLogHosts($accountId:Int!) {
      actor {
        account(id: $accountId) {
          oneDayAgo:
          nrql (query: "SELECT uniques(hostname,10000) FROM Log WHERE indexname like 'xstore%' SINCE_CLAUSE") {
            results
            metadata {
              timeWindow {
                begin
                end
              }
            }
          }
       
        }
      }
    }`
};

function requestRegion(state) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question(`What region shall we examine (options: ${Object.keys(REGIONS).join(' ')}; default: us)? `,
        (region) => {
            rl.close();
            if (region) {
                region = region.toLowerCase();
                if (REGIONS[region]) {
                    state.region = region;
                    NERDGRAPH_URL = REGIONS[region];
                } else {
                    process.stdout.write(`\nPlease enter a valid region name, or just hit 'return' to default to the US region.\nValid options are: ${Object.keys(REGIONS).join(' ')}\n`);
                    process.exit(2);
                }
            }
            process.stdout.write(`API endpoint: ${NERDGRAPH_URL}\n`);

            requestApiKey(state);
        }
    );
}

/**
 * Prompt the user to enter an API key from the console, then test the key by fetching the accessible accounts list.
 *
 * If ≥ 1 account is successfully read, then this function executes `findHosts()`. Otherwise, prints an error and exits.
 *
 * @param {out} state - an object whose apiKey and accountIds properties will be populated by this call
 */
function requestApiKey(state) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question("\nWhat is your New Relic User API Key? ",
        async (key) => {
            rl.close();
            // Track when we started scanning
            state.scanStarted = Date.now();

            process.stdout.write('Checking api key... ');
            state.apiKey = key;
            const accountIds = await fetchAccountIds(state);
            if (accountIds != undefined && accountIds.length > 0) {
                state.accountIds = accountIds;
                process.stdout.write(` OK, found ${accountIds.length} accounts.\n`);
                let hosts = await findHosts(state);
                const accountsWithHosts = [...new Set(hosts.map(item => item.accountId))]
                let hostsWithLogs_1DayAgo = await findLogHosts(state, accountsWithHosts, 'SINCE 1 DAY AGO');
                let hostsWithLogs_2DaysAgo = await findLogHosts(state,accountsWithHosts, 'SINCE 2 DAYS AGO UNTIL 1 DAY AGO')
                const inHostsNotInOneDayLogs = hosts.filter(({ hostname: hostname1 }) => !hostsWithLogs_1DayAgo.some(({ hostname: hostname2 }) => hostname2 === hostname1));
                const inOneDayLogsNotHosts = hostsWithLogs_1DayAgo.filter(({ hostname: hostname1 }) => !hosts.some(({ hostname: hostname2 }) => hostname2 === hostname1));
                const inDayOneNotDayTwo = hostsWithLogs_1DayAgo.filter(({ hostname: hostname1 }) => !hostsWithLogs_2DaysAgo.some(({ hostname: hostname2 }) => hostname2 === hostname1));
                const inDayTwoNotDayOne = hostsWithLogs_2DaysAgo.filter(({ hostname: hostname1 }) => !hostsWithLogs_1DayAgo.some(({ hostname: hostname2 }) => hostname2 === hostname1));

                process.stdout.write("A nice place to pause...\n")

            } else {
                process.stdout.write('ERROR, api key is invalid or I failed to connect to New Relic API.\n');
                process.exit(1);
            }
        }
    );
}

async function fetchAccountIds(state) {
    try {
        const res = await nerdgraphQuery(state.apiKey, QUERIES.accessibleAccounts);
        const accountIds = res['actor']['accounts'].map(a => a['id']);
        return accountIds;
    } catch (err) {
        process.stderr.write(`Error requesting accessible accounts from New Relic api.\n`);
        process.stderr.write(err.toString() + '\n');
        return undefined;
    }
}

async function findHosts(state) {
    process.stdout.write('Scanning your accounts, this may take some time...\n');
    state.hosts = state.hosts || [];

    let hosts = [];
    let resultSet = await nerdgraphQuery(state.apiKey, QUERIES.getXstoreEntities);
    const entityCount = resultSet['actor']['entitySearch']['count'];
    process.stdout.write(`Checking ${entityCount} hosts...   `);

    let batch = 1;
    while (resultSet) {
        for (const host of resultSet['actor']['entitySearch']['results']['entities']) {
            if (host['guid']) {
                hosts.push({'guid': host['guid'], 'accountId': host['accountId'], 'hostname': host['name']})
            }
        }

        const cursor = resultSet['actor']['entitySearch']['results']['nextCursor'];
        if (cursor) {
            const glyphs = '|/-\\';
            process.stdout.write(`\b\b\b ${glyphs.charAt(batch % glyphs.length)} `);
            batch += 1;
            resultSet = await nerdgraphQuery(state.apiKey, QUERIES.getMoreXstoreEntities, {cursor});
        } else {
            break;
        }
    }
    process.stdout.write(`\b\b\b done. Actual host count is ${hosts.length}.\n`);
    return hosts;
}

async function findLogHosts(state, accounts, since) {

    state.hostsWithLogs = state.hostsWithLogs || [];

    let hostsWithLogs = [];
    for (const account of accounts) {
        let data = await nerdgraphQuery(state.apiKey, QUERIES.getLogHosts.replace('SINCE_CLAUSE', 'SINCE 1 DAY AGO'), {accountId: account});

        const rowCount = data['actor']['account']['oneDayAgo']['results'][0]['uniques.hostname'].length;
        for (const hostWithLogs of data['actor']['account']['oneDayAgo']['results'][0]['uniques.hostname']) {
            if (hostWithLogs) {
                hostsWithLogs.push({'accountId': account,'hostname': hostWithLogs})
            }
        }
    }
    return hostsWithLogs;
}



async function nerdgraphQuery(apiKey, query, variables={}) {
    const payload = JSON.stringify({query, variables});

    try {
        var prms = buildRequestPromise(apiKey, payload);
        var response = await prms;
        if (response.errors) {
            process.stderr.write(`\nError returned from API: ${JSON.stringify(response.errors)}\n`);
        }
        if (response.data) {
            return response.data;
        }
    } catch (err) {
        handleNetworkError(err);
    }

    // We hit occasional networking issues that lead to timeouts or other transient issues
    // So, if the query failed try it again one time
    try {
        var prms = buildRequestPromise(apiKey, payload);
        var response = await prms;
        if (response.data) {
            return response.data;
        }
    } catch (err) {
        handleNetworkError(err);
    }

    return undefined;
}

/**
 * Figure out what to do with an error thrown by an https request.
 *
 * If err suggests the issue is a certificate error from a HTTPS proxy, then print troubleshooting info and exit.
 * Otherwise, print the error string and continue.
 *
 * @param err - the Error thrown by https.request
 */
function handleNetworkError(err) {
    const errString = err.toString();
    // check for signs that Node is rejecting a HTTPS proxy with a self-signed cert
    //   Per https://github.com/nodejs/node/blob/master/deps/openssl/openssl/include/openssl/x509_vfy.h.in#L224-L225
    //   and https://github.com/nodejs/node/blob/master/deps/openssl/openssl/crypto/x509/x509_txt.c#L60-L63
    //   err.code == 18 is X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT
    //   err.code == 19 is X509_V_ERR_SELF_SIGNED_CERT_IN_CHAIN
    if (err.code === 18 || err.code === 19 || errString.includes("self signed certificate")) {
        process.stderr.write(CERT_ERROR_HELP);
        process.exit(5);
    }
    else {
        process.stderr.write(`\nException processing API call: ${errString}\n`);
    }
}

/**
 * Build a promise that will send the provided payload to nerdgraph and resolve to the response body.
 *
 * @param apiKey - New Relic User API key for executing a nerdgraph query
 * @param payload - string containing the json-encoded graphql payload
 * @returns a Promise that, when resolved, will execute the requests and return the deserialized json response
 */
function buildRequestPromise(apiKey, payload) {
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            'API-Key': apiKey,
            'NewRelic-Requesting-Services': 'nr-logs-by-host'
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(NERDGRAPH_URL, options, (res) => {
            let body = '';

            res.on('data', (chunk) => {
                body += chunk;
            });

            res.on('end', () => {
                resolve(JSON.parse(body));
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.write(payload)
        req.end();
    });
}


try {
    process.stdout.write(INTRO_TEXT);
    requestRegion(STATE);

}
catch {

}