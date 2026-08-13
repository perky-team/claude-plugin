#!/usr/bin/env node
// Does an agent answer structural questions better WITH the graph than without?
//
//   node plugins/p-graph/scripts/measure-agent.mjs --phase base
//   node plugins/p-graph/scripts/measure-agent.mjs --phase graph
//   node plugins/p-graph/scripts/measure-agent.mjs --score
//
// `measure.mjs` asks whether the graph's own rows are right. This asks the
// question a user actually has: is the ANSWER better, and what did it cost.
//
// Two arms over the same clones:
//   base   the repo as it comes. No .pgraph, no rule, no plugin.
//   graph  the same repo, indexed, with the p-graph rule in CLAUDE.md and the
//          plugin loaded, so /p-graph:query and the CLI are both available.
// Everything else is held equal: same model, same tools, same question text.
//
// Scoring is mechanical, not judged by a model. Each question carries a
// hand-built list of the real call sites (see TRUTH below, and the write-up for
// how each list was built). An answer covers a call site if it cites that file
// and a line inside the calling function — so "the caller is `Foo` at line 95"
// and "the call is at line 97" both count.
//
// Runs are appended to runs.jsonl in the work dir and never repeated, so the
// script can be stopped and restarted.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const CLI = join(PLUGIN, 'tools', 'pgraph.mjs');
const RULE = join(PLUGIN, 'skills', '_shared', 'templates', 'p-graph-rule.template.md');

// The user's own machine has p-graph, p-wiki and a Go LSP switched on for every
// session. Left alone, the BASE arm would quietly have them too and the whole
// comparison would be void. This override switches all three off in both arms;
// the graph arm gets p-graph back through --plugin-dir, and nothing else.
const OFF = JSON.stringify({
  enabledPlugins: {
    'p-graph@perky.team': false,
    'p-wiki@perky.team': false,
    'p-statusline@perky.team': false,
    'gopls-lsp@claude-plugins-official': false,
  },
  language: 'English',
});

const RUNS = 3;
const MODEL = 'sonnet';

// Ground truth. `call` is the line the call is written on; `def` is the first
// line of the function that contains it. Both were read by hand — see the
// write-up for how each list was settled.
const T = (file, pairs) => pairs.map(([call, def]) => ({ file, call, def }));
// Lines that are neither a call site nor a mistake, so they count for neither
// side. Two shapes: the target's own definition (the question says not to list
// it, and quoting it as context is a slip, not an invented caller), and a call
// that really can reach the target at run time but no static tool can name —
// `getattr(jar, "update")()`, a call through an interface. Both were read.
const N = (file, from, to) => ({ file, from, to });

const QUESTIONS = [
  {
    id: 'caddy-sanitizedpathjoin', repo: 'caddy', lang: 'Go', kind: 'recall',
    question: 'List every place in this repository that calls the function `SanitizedPathJoin` (package caddyhttp). For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('modules/caddyhttp/caddyhttp_test.go', [[139, 10]]),
      ...T('modules/caddyhttp/fileserver/browsetplcontext.go', [[85, 37]]),
      ...T('modules/caddyhttp/fileserver/matcher.go', [[390, 333]]),
      ...T('modules/caddyhttp/fileserver/staticfiles.go', [[296, 269], [327, 269]]),
      ...T('modules/caddyhttp/reverseproxy/fastcgi/fastcgi.go', [[310, 257], [372, 257]]),
    ],
    neutral: [N('modules/caddyhttp/caddyhttp.go', 252, 274)],
  },
  {
    id: 'hugo-helpers-exists', repo: 'hugo', lang: 'Go', kind: 'recall',
    question: 'List every place in this repository that calls the function `Exists` from the `helpers` package. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('commands/gen.go', [[125, 39], [174, 39]]),
      ...T('commands/import.go', [[164, 162], [486, 476]]),
      ...T('config/allconfig/load.go', [[520, 509], [527, 509]]),
      ...T('create/skeletons/skeletons.go', [[38, 37], [97, 95], [117, 95]]),
      ...T('helpers/path_test.go', [[247, 226]]),
      ...T('resources/transform_test.go', [[90, 51]]),
    ],
    neutral: [N('helpers/path.go', 340, 342)],
  },
  {
    id: 'hugo-getbuffer', repo: 'hugo', lang: 'Go', kind: 'recall',
    question: 'List every place in this repository that calls the function `GetBuffer` from the `bufferpool` package. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('bufferpool/bufpool_test.go', [[25, 22]]),
      ...T('helpers/general.go', [[66, 62], [81, 77]]),
      ...T('hugolib/hugo_sites_build.go', [[560, 519]]),
      ...T('hugolib/page__per_output.go', [[500, 499]]),
      ...T('hugolib/shortcode.go', [[87, 82], [518, 357], [773, 772]]),
      ...T('hugolib/site.go', [[1643, 1641]]),
      ...T('markup/goldmark/autoid.go', [[45, 44]]),
      ...T('markup/goldmark/hugocontext/hugocontext.go', [[42, 41]]),
      ...T('markup/goldmark/internal/render/context.go', [[234, 233]]),
      ...T('publisher/publisher.go', [[104, 94]]),
      ...T('resources/transform.go', [[509, 506], [510, 506], [683, 506]]),
      ...T('tpl/encoding/encoding.go', [[118, 87]]),
      ...T('tpl/partials/partials.go', [[178, 147]]),
      ...T('tpl/template.go', [[133, 117]]),
      ...T('tpl/transform/transform.go', [[243, 242]]),
      ...T('transform/chain.go', [[83, 77], [90, 77]]),
      ...T('transform/urlreplacers/absurlreplacer_test.go', [[206, 205], [209, 205]]),
    ],
    neutral: [N('bufferpool/bufpool.go', 29, 31)],
  },
  {
    // Added for the Go round, before any code changed, for the reason both earlier
    // rounds learned: the other three Go questions are all package-level functions,
    // the one shape that already worked. A call through an INTERFACE is Go's
    // defining idiom and the set did not ask about it once.
    //
    // It is also the shape a text search is worst at. 171 lines in caddy carry the
    // name `ServeHTTP` and 107 of them are calls, but only these 34 go through the
    // `Handler` interface: the rest are the three-argument `MiddlewareHandler`
    // form, or the standard library's own `http.Handler`. Telling them apart means
    // reading the receiver's declaration at every one of the 107.
    //
    // The truth list was built by hand from the receiver declarations: a parameter
    // or field written `Handler`, or the result of `Routes.Compile(…)`, which
    // returns one. Every call the graph had already tied to a concrete type was
    // checked out; every call it could not type was read in the source.
    id: 'caddy-handler-servehttp', repo: 'caddy', lang: 'Go', kind: 'recall',
    question: 'List every place in this repository that calls the `ServeHTTP` method declared by the `Handler` interface in `modules/caddyhttp/caddyhttp.go` — the two-argument form that returns an error. For each one give the file path and the line number. Do not list the definition itself, and do not list calls to the three-argument `MiddlewareHandler.ServeHTTP` or to the standard library\'s `http.Handler`.',
    truth: [
      ...T('modules/caddyhttp/caddyauth/caddyauth.go', [[172, 89]]),
      ...T('modules/caddyhttp/encode/encode.go', [[191, 164]]),
      ...T('modules/caddyhttp/encode/encode_conformance_test.go', [[257, 229]]),
      ...T('modules/caddyhttp/fileserver/staticfiles.go', [[735, 733]]),
      ...T('modules/caddyhttp/headers/headers.go', [[110, 90]]),
      ...T('modules/caddyhttp/intercept/intercept.go', [[150, 115], [190, 115]]),
      ...T('modules/caddyhttp/invoke.go', [[48, 45]]),
      ...T('modules/caddyhttp/logging/logappend.go', [[95, 63]]),
      ...T('modules/caddyhttp/map/map.go', [[171, 124]]),
      ...T('modules/caddyhttp/metrics.go', [[353, 314]]),
      ...T('modules/caddyhttp/metrics_test.go', [[616, 602]]),
      ...T('modules/caddyhttp/push/handler.go', [[79, 76], [84, 76], [129, 76]]),
      ...T('modules/caddyhttp/requestbody/requestbody.go', [[81, 67], [104, 67]]),
      ...T('modules/caddyhttp/reverseproxy/copyresponse.go', [[177, 145]]),
      ...T('modules/caddyhttp/reverseproxy/reverseproxy.go', [[1190, 991]]),
      ...T('modules/caddyhttp/rewrite/rewrite.go', [[139, 132], [152, 132]]),
      ...T('modules/caddyhttp/routes.go', [[281, 256], [292, 256], [323, 256]]),
      ...T('modules/caddyhttp/server.go', [[533, 421], [650, 582], [681, 663]]),
      ...T('modules/caddyhttp/staticresp.go', [[254, 181]]),
      ...T('modules/caddyhttp/subroute.go', [[74, 72], [78, 72]]),
      ...T('modules/caddyhttp/templates/templates.go', [[457, 438]]),
      ...T('modules/caddyhttp/tracing/tracer.go', [[117, 98]]),
      ...T('modules/caddyhttp/vars.go', [[73, 57]]),
      ...T('modules/caddypki/acmeserver/acmeserver.go', [[250, 235]]),
    ],
    // The interface itself, the HandlerFunc adapter that satisfies it, the
    // MiddlewareHandler interface beside it and the emptyHandler value — naming any
    // of those is a correct observation about how the method is reached, not a call
    // site. Plus the two doc comments that write `.ServeHTTP(` in prose.
    neutral: [
      N('modules/caddyhttp/caddyhttp.go', 60, 100),
      N('modules/caddyhttp/caddyhttp.go', 120, 130),
      N('modules/caddyhttp/responsewriter.go', 100, 110),
    ],
  },
  {
    id: 'flask-flashed', repo: 'flask', lang: 'Python', kind: 'recall',
    question: 'List every place in this repository\'s Python code that calls the function `get_flashed_messages`. For each one give the file path and the line number. Do not list the definition itself.',
    truth: T('tests/test_basic.py', [[623, 617], [642, 641], [652, 651], [663, 662], [671, 670], [682, 681]]),
    // The definition, the re-export, and the line that hands the function to
    // Jinja (`get_flashed_messages=get_flashed_messages`). The last one is why
    // templates can call it — a fair thing to name, and not a call.
    neutral: [N('src/flask/helpers.py', 360, 399), N('src/flask/__init__.py', 15, 15),
      N('src/flask/app.py', 41, 41), N('src/flask/app.py', 497, 497)],
  },
  {
    id: 'requests-cookiejar-update', repo: 'requests', lang: 'Python', kind: 'recall',
    question: 'List every place in this repository that calls the `update` method of the `RequestsCookieJar` class. For each one give the file path and the line number. Do not list the definition itself.',
    truth: T('src/requests/cookies.py', [[471, 467]]),
    // 391-399 is the definition. 619-620 is `getattr(cookiejar, "update")` then
    // a call on the result: it really does reach this method when the jar is a
    // RequestsCookieJar, and no static tool can say so. Neither right nor wrong.
    neutral: [N('src/requests/cookies.py', 391, 399), N('src/requests/cookies.py', 617, 620)],
  },
  {
    id: 'leveldb-totalfilesize', repo: 'leveldb', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the function `TotalFileSize`. For each one give the file path and the line number. Do not list the definition itself.',
    truth: T('db/version_set.cc', [[486, 470], [1054, 1031], [1164, 1161], [1175, 1167],
      [1406, 1385], [1407, 1385], [1408, 1385], [1505, 1499]]),
    neutral: [N('db/version_set.cc', 59, 65)],
  },
  {
    id: 'nest-serialize', repo: 'nest', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository that calls the `serialize` method of the `ClassSerializerInterceptor` class. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('packages/common/serializer/class-serializer.interceptor.ts', [[62, 52]]),
      ...T('packages/common/test/serializer/class-serializer.interceptor.spec.ts',
        [[175, 174], [176, 174], [177, 174], [181, 180], [185, 184], [190, 188],
          [202, 196], [216, 208], [227, 224], [424, 407], [434, 431], [446, 440]]),
    ],
    neutral: [N('packages/common/serializer/class-serializer.interceptor.ts', 70, 102)],
  },
  {
    // Added for the TypeScript round, and added BEFORE any fix, for the reason the
    // C++ round learned the hard way: the three TypeScript questions above are two
    // free functions and one method reached through a plain local, and all three of
    // those shapes already worked. A fix to the shape TypeScript actually writes
    // could not have shown up in the A/B at all.
    //
    // This is that shape: every call is `this.pipesContextCreator.create(…)` — a
    // call on a class FIELD. It is also the shape a text search is worst at. 75
    // nodes in this repo are named `create`, and `.create(` is written 145 times in
    // packages/ alone, so the name alone tells the reader nothing.
    id: 'nest-pipescontextcreator-create', repo: 'nest', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository that calls the `create` method of the `PipesContextCreator` class (packages/core/pipes). For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('packages/core/helpers/external-context-creator.ts', [[114, 91]]),
      ...T('packages/core/router/router-execution-context.ts', [[112, 80]]),
      ...T('packages/microservices/context/rpc-context-creator.ts', [[82, 58]]),
      ...T('packages/websockets/context/ws-context-creator.ts', [[74, 57]]),
    ],
    // The class header and the definition itself.
    neutral: [N('packages/core/pipes/pipes-context-creator.ts', 11, 36)],
  },
  {
    // The second added question, and the one the flagship TypeScript question was
    // already failing on without anybody asking it: `nest-serialize` printed 20 gap
    // rows, and all 20 were these calls — a different `serialize` entirely. Reading
    // them needs four facts in a row: the receiver is a class field, the field is
    // declared on a BASE class, its type is an alias, and the alias names an
    // INTERFACE. Before this round p-graph had none of the four, so
    // `callers "Serializer.serialize"` answered "no symbol named …".
    id: 'nest-serializer-serialize', repo: 'nest', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository that calls the `serialize` method declared by the `Serializer` interface (packages/microservices/interfaces/serializer.interface.ts). For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('packages/microservices/client/client-kafka.ts', [[341, 332], [358, 356], [400, 382]]),
      // Line 243 sits in `publishPacket`, a local arrow function inside `publish`.
      // The def line is the named method's, so naming either one counts.
      ...T('packages/microservices/client/client-mqtt.ts', [[243, 220], [279, 271]]),
      ...T('packages/microservices/client/client-nats.ts', [[211, 204], [238, 236]]),
      ...T('packages/microservices/client/client-redis.ts', [[293, 286], [329, 327]]),
      ...T('packages/microservices/client/client-rmq.ts', [[395, 374], [448, 446]]),
      ...T('packages/microservices/client/client-tcp.ts', [[195, 189], [209, 207]]),
      ...T('packages/microservices/server/server-kafka.ts', [[311, 304]]),
      ...T('packages/microservices/server/server-mqtt.ts', [[184, 169]]),
      ...T('packages/microservices/server/server-nats.ts', [[184, 179]]),
      ...T('packages/microservices/server/server-redis.ts', [[179, 176]]),
      ...T('packages/microservices/server/server-rmq.ts', [[368, 362]]),
      ...T('packages/microservices/server/server-tcp.ts', [[107, 93], [125, 93]]),
    ],
    // The interface and its two aliases, the five classes that implement it, and
    // the five spec files that call those classes directly. A call written on a
    // CONCRETE serializer targets that class's own method, not the interface — but
    // "it implements the interface, so it is the same method" is a defensible
    // reading, and neither arm should be scored on which reading it picked.
    neutral: [
      N('packages/microservices/interfaces/serializer.interface.ts', 1, 18),
      N('packages/microservices/serializers/identity.serializer.ts', 1, 7),
      N('packages/microservices/serializers/kafka-request.serializer.ts', 1, 57),
      N('packages/microservices/serializers/mqtt-record.serializer.ts', 1, 16),
      N('packages/microservices/serializers/nats-record.serializer.ts', 1, 36),
      N('packages/microservices/serializers/rmq-record.serializer.ts', 1, 25),
      N('packages/microservices/test/serializers/identity.serializer.spec.ts', 1, 15),
      N('packages/microservices/test/serializers/kafka-request.serializer.spec.ts', 1, 151),
      N('packages/microservices/test/serializers/mqtt-record.serializer.spec.ts', 1, 40),
      N('packages/microservices/test/serializers/nats-record.serializer.spec.ts', 1, 105),
      N('packages/microservices/test/serializers/rmq-record.serializer.spec.ts', 1, 39),
    ],
  },
  {
    id: 'leveldb-writebatch-count', repo: 'leveldb', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the `Count` method of `WriteBatchInternal`. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('db/db_impl.cc', [[450, 385], [1228, 1206], [1319, 1281]]),
      ...T('db/repair.cc', [[192, 143]]),
      ...T('db/write_batch.cc', [[75, 42], [99, 98], [106, 105], [145, 144]]),
      ...T('db/write_batch_test.cc', [[47, 14], [57, 54], [67, 60]]),
    ],
    // The out-of-class definition and the header declaration.
    neutral: [N('db/write_batch.cc', 82, 86), N('db/write_batch_internal.h', 20, 20)],
  },
  {
    id: 'leveldb-setsequence', repo: 'leveldb', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the `SetSequence` method of `WriteBatchInternal`. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('db/db_impl.cc', [[1227, 1206]]),
      ...T('db/recovery_test.cc', [[149, 142]]),
      ...T('db/write_batch_test.cc', [[65, 60], [79, 75], [91, 89], [92, 89]]),
      ...T('table/table_test.cc', [[730, 725]]),
    ],
    neutral: [N('db/write_batch.cc', 94, 97), N('db/write_batch_internal.h', 30, 30)],
  },
  // The two questions below were added because the C++ set had none of the shape
  // the plugin is actually weakest at. Every earlier C++ question is a free
  // function or a static method — resolved through the name, with no receiver to
  // type. These two are calls written ON A VALUE, which is 40% of leveldb's call
  // edges and where the graph holds nothing certain. Measured before they were
  // added, so the sizes are known in advance: `WriteBatch::Put` shares its bare
  // name with nine other classes, and `Cache::Insert` is a pure virtual that the
  // graph does not index at all.
  {
    id: 'leveldb-writebatch-put', repo: 'leveldb', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the `Put` method of the `WriteBatch` class (the two-argument `Put(key, value)`, not `DB::Put`). For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('benchmarks/db_bench.cc', [[855, 838]]),
      ...T('db/c.cc', [[334, 332]]),
      ...T('db/corruption_test.cc', [[64, 57], [218, 210]]),
      ...T('db/db_impl.cc', [[1491, 1489]]),
      ...T('db/db_test.cc', [[2330, 2292]]),
      ...T('db/fault_injection_test.cc', [[403, 397]]),
      ...T('db/recovery_test.cc', [[148, 142]]),
      ...T('db/write_batch_test.cc', [[62, 60], [64, 60], [77, 75], [95, 89], [99, 89],
        [119, 115], [123, 115]]),
      ...T('issues/issue178_test.cc', [[44, 27], [51, 27]]),
      ...T('issues/issue320_test.cc', [[78, 41], [101, 41]]),
      ...T('table/table_test.cc', [[343, 337], [731, 725], [732, 725], [733, 725], [734, 725]]),
    ],
    // The definition, the declaration, and the four lines of the header's usage
    // comment — quoting a doc example is a slip, not an invented caller.
    // `db/write_batch.cc:59` is NOT here: `handler->Put(key, value)` calls
    // `WriteBatch::Handler::Put`, a different method on a different type, so
    // listing it is an error and both sides face it equally.
    neutral: [N('db/write_batch.cc', 98, 101), N('include/leveldb/write_batch.h', 51, 51),
      N('include/leveldb/write_batch.h', 11, 14)],
  },
  {
    id: 'leveldb-cache-insert', repo: 'leveldb', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls `Insert` through the `leveldb::Cache` interface — that is, where the receiver is a `Cache*` or a `Cache&`, not a concrete cache class. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('db/table_cache.cc', [[72, 41]]),
      ...T('table/table.cc', [[181, 153]]),
      ...T('util/cache_test.cc', [[53, 52], [58, 57]]),
    ],
    // The pure virtual declaration, and the two concrete implementations a
    // reader may fairly name because they are what actually runs.
    neutral: [N('include/leveldb/cache.h', 57, 58), N('util/cache.cc', 355, 366),
      N('util/cache.cc', 283, 300)],
  },
  {
    id: 'nest-extendarraymetadata', repo: 'nest', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository that calls the function `extendArrayMetadata`. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('packages/common/decorators/core/exception-filters.decorator.ts', [[52, 29], [60, 29]]),
      ...T('packages/common/decorators/core/use-guards.decorator.ts', [[47, 28], [51, 28]]),
      ...T('packages/common/decorators/core/use-interceptors.decorator.ts', [[50, 28], [64, 28]]),
      ...T('packages/common/decorators/core/use-pipes.decorator.ts', [[42, 29], [46, 29]]),
      ...T('packages/common/decorators/http/header.decorator.ts', [[27, 18]]),
      ...T('packages/common/test/utils/extend-metadata.util.spec.ts', [[7, 5], [14, 11], [21, 18]]),
    ],
    neutral: [N('packages/common/utils/extend-metadata.util.ts', 1, 9)],
  },
  {
    id: 'nest-validateeach', repo: 'nest', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository that calls the function `validateEach`. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('packages/common/decorators/core/exception-filters.decorator.ts', [[45, 29], [59, 29]]),
      ...T('packages/common/decorators/core/use-guards.decorator.ts', [[40, 28], [50, 28]]),
      ...T('packages/common/decorators/core/use-interceptors.decorator.ts', [[43, 28], [57, 28]]),
      ...T('packages/common/decorators/core/use-pipes.decorator.ts', [[41, 29], [45, 29]]),
      ...T('packages/common/test/utils/validate-each.util.spec.ts', [[12, 10], [18, 17]]),
    ],
    neutral: [N('packages/common/utils/validate-each.util.ts', 1, 31)],
  },
  {
    // Added so C++ is measured on two repositories, not one. leveldb is small and
    // tidy; re2 is bigger, uses namespaces, and splits a class over several files.
    // This question is the easy shape on purpose — a distinctive name — with one
    // catch a text search has to notice: `NFA::Incref` is a different method with
    // the same name, and three of the 49 lines carrying `Incref` are calls to it.
    id: 're2-regexp-incref', repo: 're2', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the `Incref` method of the `re2::Regexp` class. For each one give the file path and the line number. Do not list the definition itself, and do not list calls to `NFA::Incref`, which is a different method.',
    truth: [
      ...T('app/_re2.cc', [[50, 29]]),
      ...T('re2/compile.cc', [[1003, 989], [1008, 989], [1017, 989],
        [1050, 1036], [1055, 1036], [1064, 1036]]),
      ...T('re2/parse.cc', [[1155, 1105], [1264, 1237]]),
      ...T('re2/re2.cc', [[253, 205]]),
      ...T('re2/regexp.cc', [[224, 206], [720, 696]]),
      ...T('re2/set.cc', [[83, 58]]),
      ...T('re2/simplify.cc', [[222, 221], [230, 225], [239, 233], [243, 233], [271, 233],
        [353, 348], [448, 447], [456, 451], [462, 459], [488, 467], [495, 467], [511, 467],
        [534, 467], [571, 467], [618, 602], [622, 602], [627, 602], [628, 602], [638, 602],
        [649, 602], [655, 602], [657, 602], [686, 677]]),
      ...T('re2/testing/regexp_test.cc', [[24, 20], [38, 33]]),
    ],
    // The definition, the declaration in the header, and the four comments that
    // write the name in prose. Quoting one of those is a slip, not a caller.
    neutral: [N('re2/regexp.cc', 103, 103), N('re2/regexp.h', 375, 375),
      N('re2/regexp.h', 422, 422), N('re2/regexp.h', 579, 579),
      N('re2/parse.cc', 768, 768), N('re2/simplify.cc', 206, 206)],
  },
  {
    // The hard shape for C++, and the reason re2 was picked. `size` is declared by
    // six classes in this repository and by half the standard library: 344 lines
    // write `.size()` or `->size()`, and 25 of them are this method. Telling them
    // apart means reading the receiver's declaration at every one. Eight of the 25
    // have no receiver at all — a bare `size()` inside a `Prog` method.
    id: 're2-prog-size', repo: 're2', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the `size` method of the `re2::Prog` class, declared in `re2/prog.h`. For each one give the file path and the line number. Do not list the definition itself, and do not list calls to a `size` method of any other class or of the standard library.',
    truth: [
      ...T('re2/dfa.cc', [[432, 421], [441, 421], [465, 421], [466, 421]]),
      ...T('re2/nfa.cc', [[142, 134], [143, 134], [661, 660], [662, 660]]),
      ...T('re2/onepass.cc', [[409, 383]]),
      ...T('re2/prog.cc', [[163, 161], [464, 453], [571, 564], [573, 564], [577, 564],
        [578, 564], [596, 564]]),
      ...T('re2/re2.cc', [[321, 318], [330, 324], [356, 355], [760, 653], [780, 653],
        [806, 653], [849, 653]]),
      ...T('re2/set.cc', [[153, 131]]),
      ...T('re2/testing/backtrack.cc', [[130, 100]]),
    ],
    // The definition, and the two comments that write `prog->size()` in prose.
    neutral: [N('re2/prog.h', 230, 230), N('re2/compile.cc', 1095, 1095),
      N('re2/dfa.cc', 847, 847)],
  },
  {
    // Added so TypeScript is measured on two repositories, not one. nest is a
    // large framework built on decorators; got is a small library built on one
    // long class. The easy shape: a private method with a name nothing else uses.
    id: 'got-beforeerror', repo: 'got', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository that calls the `_beforeError` method of the `Request` class. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('source/as-promise/index.ts', [[70, 45], [75, 45], [175, 45], [182, 45], [199, 194]]),
      ...T('source/core/index.ts', [[420, 354], [480, 441], [900, 894], [1096, 991],
        [1111, 991], [1184, 991], [1204, 991], [1224, 991], [1230, 991], [1339, 991],
        [1399, 991], [1414, 991], [1537, 1532], [1578, 1571], [1615, 1541], [1709, 1662],
        [1799, 1730], [1942, 1940], [1947, 1940], [2040, 1979]]),
    ],
    // The definition, the two comments beside it, the two documentation files that
    // print the name, and the test that asserts on the name inside a stack trace
    // string — that last one reaches the method at run time and is not a call.
    neutral: [N('source/core/index.ts', 484, 484), N('source/core/index.ts', 418, 422),
      N('documentation/3-streams.md', 369, 369), N('documentation/async-stack-traces.md', 191, 191),
      N('test/error.ts', 394, 394)],
  },
  {
    id: 'got-options-merge', repo: 'got', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository\'s TypeScript code — files under `source/` and `test/` — that calls the `merge` method of the `Options` class. For each one give the file path and the line number. Do not list the definition itself, and do not count code written inside a documentation comment.',
    truth: [
      ...T('source/as-promise/index.ts', [[113, 45]]),
      ...T('source/core/options.ts', [[1652, 1619], [1653, 1619], [1659, 1619], [1690, 1680]]),
      ...T('source/create.ts', [[166, 158], [171, 158], [304, 189]]),
      ...T('test/normalize-arguments.ts', [[119, 107], [127, 107], [195, 192], [206, 203],
        [209, 203], [212, 203], [215, 203], [218, 203], [221, 203], [224, 203]]),
    ],
    // The definition, the `@example` block inside the `afterResponse` doc comment
    // — real-looking code that is never compiled — and the three markdown pages.
    neutral: [N('source/core/options.ts', 1680, 1680), N('source/core/options.ts', 519, 620),
      N('documentation/10-instances.md', 42, 42), N('documentation/2-options.md', 1090, 1090),
      N('documentation/9-hooks.md', 350, 350)],
  },
  {
    id: 'requests-super-len', repo: 'requests', lang: 'Python', kind: 'recall',
    question: 'List every place in this repository that calls the function `super_len`. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('src/requests/models.py', [[605, 576], [657, 654]]),
      ...T('tests/test_utils.py', [[63, 61], [64, 61], [70, 66], [83, 80], [96, 93], [99, 98],
        [112, 108], [125, 115], [129, 127], [137, 134], [141, 139], [143, 139], [147, 145], [153, 151]]),
    ],
    neutral: [N('src/requests/utils.py', 160, 200)],
  },
  {
    // Third Go repository. gin is a web framework — small, and built around one
    // very large `Context` type. The plain shape: a package-level function.
    id: 'gin-stringtobytes', repo: 'gin', lang: 'Go', kind: 'recall',
    question: 'List every place in this repository that calls the function `StringToBytes` from the `bytesconv` package. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('auth.go', [[37, 32], [93, 91]]),
      ...T('binding/form_mapping.go', [[376, 323], [378, 323]]),
      ...T('internal/bytesconv/bytesconv_test.go', [[84, 81], [91, 90], [122, 120]]),
      ...T('render/json.go', [[101, 94], [102, 94], [103, 94], [130, 117], [134, 117], [142, 117]]),
      ...T('render/text.go', [[39, 33]]),
    ],
    // The comment above the definition, the definition, and the two lines that
    // write the name inside a `t.Fatalf` format string.
    neutral: [N('internal/bytesconv/bytesconv.go', 11, 13),
      N('internal/bytesconv/bytesconv_test.go', 93, 96)],
  },
  {
    // HARD, and the reason gin was picked. 77 lines write `.Render(` and 21 types
    // own a method called `Render`. Only these 22 are `Context.Render`, the
    // two-argument form; the rest call the one-argument `Render(w)` on one of the
    // twenty types that satisfy the `render.Render` interface. Telling the two
    // apart means reading the receiver at every line.
    id: 'gin-context-render', repo: 'gin', lang: 'Go', kind: 'recall',
    question: 'List every place in this repository that calls the `Render` method of the `gin.Context` type — the two-argument form `Render(code int, r render.Render)`. For each one give the file path and the line number. Do not list the definition itself, and do not list calls to the one-argument `Render(w http.ResponseWriter)` method that the render types implement.',
    truth: [
      ...T('context.go', [[1223, 1221], [1231, 1230], [1238, 1237], [1247, 1244], [1250, 1244],
        [1256, 1255], [1262, 1261], [1268, 1267], [1274, 1273], [1280, 1279], [1285, 1284],
        [1290, 1289], [1295, 1294], [1300, 1299], [1305, 1304], [1310, 1309], [1319, 1318],
        [1327, 1326], [1370, 1369]]),
      ...T('context_test.go', [[1141, 1137], [1520, 1515]]),
      ...T('middleware_test.go', [[243, 229]]),
    ],
    // The definition, which itself calls the interface method on the next lines,
    // the doc comment in errors.go, and the test type that implements the
    // interface. Naming any of those is a correct observation, not a caller.
    neutral: [N('context.go', 1202, 1211), N('errors.go', 21, 21),
      N('context_test.go', 1131, 1133)],
  },
  {
    // Third C++ repository. spdlog is header-mostly, uses namespaces heavily and
    // vendors the whole of fmt under include/spdlog/fmt/bundled. The plain shape:
    // a free function in a nested namespace, with one trap — the test file wraps
    // it in `try_create_dir`, and nine lines call the wrapper, not the function.
    id: 'spdlog-create-dir', repo: 'spdlog', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the function `create_dir` from the `spdlog::details::os` namespace. For each one give the file path and the line number. Do not list the definition itself, and do not list calls to the test helper `try_create_dir`.',
    truth: [
      ...T('include/spdlog/details/file_helper-inl.h', [[38, 26]]),
      ...T('tests/test_create_dir.cpp', [[11, 10], [44, 43], [45, 43], [47, 43], [55, 51],
        [57, 51], [58, 51], [133, 129], [140, 136], [150, 143], [152, 143]]),
      ...T('tests/test_errors.cpp', [[98, 94]]),
      ...T('tests/test_misc.cpp', [[222, 216]]),
    ],
    // The definition, the declaration, and the two `using` lines that bring the
    // name into scope.
    neutral: [N('include/spdlog/details/os-inl.h', 485, 485),
      N('include/spdlog/details/os.h', 107, 107),
      N('tests/test_create_dir.cpp', 7, 7), N('tests/test_misc.cpp', 217, 217)],
  },
  {
    // HARD. `log` is the most overloaded name in spdlog: a free function, eight
    // overloads on `logger`, and this one — the pure virtual on `sinks::sink` that
    // every sink implements. Outside the vendored fmt, 43 lines call something
    // named `log`; 29 of them are this one, and the receiver is the only way to
    // tell. It is also the virtual-dispatch shape, with six implementations.
    id: 'spdlog-sink-log', repo: 'spdlog', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the `log` method declared by the `spdlog::sinks::sink` class in `include/spdlog/sinks/sink.h` — the one-argument form that takes a `log_msg`. For each one give the file path and the line number. Do not list the definition itself, and do not list calls to `logger::log` or to the free function `spdlog::log`.',
    truth: [
      ...T('include/spdlog/async_logger-inl.h', [[65, 62]]),
      ...T('include/spdlog/logger-inl.h', [[138, 135]]),
      ...T('include/spdlog/sinks/dist_sink.h', [[53, 50]]),
      ...T('tests/test_daily_logger.cpp', [[148, 134]]),
      ...T('tests/test_dup_filter.cpp', [[14, 5], [29, 20], [45, 36], [46, 36], [60, 52],
        [62, 52], [75, 66], [76, 66], [77, 66], [78, 66]]),
      ...T('tests/test_pattern_formatter.cpp', [[282, 273], [287, 273], [300, 291], [305, 291]]),
      ...T('tests/test_ringbuffer.cpp', [[12, 8], [13, 8], [14, 8], [28, 24], [29, 24], [30, 24],
        [43, 39], [44, 39], [45, 39], [65, 56]]),
      ...T('tests/test_time_point.cpp', [[17, 5]]),
    ],
    neutral: [N('include/spdlog/sinks/sink.h', 15, 15)],
  },
  {
    // Third Python repository, and the one with real type annotations — flask and
    // requests have almost none, so this is the first Python question where the
    // source says what the receiver is.
    id: 'httpx-raise-for-status', repo: 'httpx', lang: 'Python', kind: 'recall',
    question: 'List every place in this repository\'s Python code that calls the `raise_for_status` method of the `Response` class. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('tests/client/test_async_client.py', [[124, 115], [127, 115]]),
      ...T('tests/client/test_client.py', [[142, 134], [146, 134]]),
      ...T('tests/client/test_event_hooks.py', [[53, 52], [105, 104]]),
      ...T('tests/models/test_responses.py', [[96, 95], [102, 101], [113, 112], [125, 124],
        [136, 135], [146, 145]]),
    ],
    // The definition and the three docstrings that write the name — one of them a
    // full worked example that looks like code and is never run.
    neutral: [N('httpx/_models.py', 794, 805), N('httpx/_exceptions.py', 74, 90),
      N('httpx/_exceptions.py', 262, 262), N('tests/models/test_responses.py', 142, 143),
      N('docs/quickstart.md', 280, 545), N('docs/api.md', 73, 73),
      N('docs/advanced/event-hooks.md', 28, 28), N('CHANGELOG.md', 100, 700)],
  },
  {
    // HARD. Three different things here own a method called `set`: this one,
    // `QueryParams.set` in the same repository, and `threading.Event.set`. Python
    // writes no types at these call sites, so the receiver has to be traced back.
    id: 'httpx-cookies-set', repo: 'httpx', lang: 'Python', kind: 'recall',
    question: 'List every place in this repository\'s Python code that calls the `set` method of the `Cookies` class. For each one give the file path and the line number. Do not list the definition itself, and do not list calls to `QueryParams.set` or to any other `set` method.',
    truth: [
      ...T('httpx/_models.py', [[1089, 1084], [1093, 1084], [1211, 1210]]),
      ...T('tests/models/test_cookies.py', [[26, 23], [35, 33], [36, 33], [47, 45], [48, 45],
        [92, 90], [93, 90]]),
    ],
    neutral: [N('httpx/_models.py', 1117, 1130), N('docs/api.md', 150, 150),
      N('docs/quickstart.md', 405, 415), N('CHANGELOG.md', 400, 400)],
  },
  {
    // HARD, and the reason axios was picked. 34 lines in the JavaScript here write
    // `.has(` and most of them are a `Set`; 26 are this method. axios is also the
    // plain-JavaScript half of what p-graph calls TypeScript — nest and got are
    // both written in TypeScript, so nothing in the set tested the other half.
    id: 'axios-headers-has', repo: 'axios', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository that calls the `has` method of the `AxiosHeaders` class. For each one give the file path and the line number. Do not list the definition itself, and do not list calls to `Set.prototype.has` or to the browser\'s own `Headers.has`.',
    truth: [
      ...T('tests/module/cjs/tests/helpers/cjs-typing.ts', [[473, 473]]),
      ...T('tests/module/esm/tests/helpers/esm-index.ts', [[543, 543]]),
      ...T('tests/unit/axiosHeaders.test.js', [[265, 249], [425, 420], [426, 420], [435, 430],
        [436, 430], [445, 445], [453, 453], [463, 458], [464, 458], [475, 470], [479, 470],
        [501, 492], [502, 492], [503, 492], [512, 507], [516, 507], [520, 507], [534, 523],
        [541, 523], [549, 544], [553, 544], [557, 544], [648, 635], [652, 635]]),
    ],
    // The definition, and the six markdown pages that print the call in an
    // example. The docs are not code and both sides quote them.
    neutral: [N('lib/core/AxiosHeaders.js', 289, 300), N('README.md', 1445, 1445),
      N('docs/pages/advanced/headers.md', 137, 137),
      N('docs/pages/advanced/interceptors.md', 93, 93),
      N('docs/es/pages/advanced/interceptors.md', 91, 91),
      N('docs/fr/pages/advanced/interceptors.md', 91, 91),
      N('docs/zh/pages/advanced/interceptors.md', 91, 91)],
  },
  {
    id: 'axios-eject', repo: 'axios', lang: 'TypeScript', kind: 'recall',
    question: 'List every place in this repository that calls the `eject` method of the `InterceptorManager` class. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      ...T('tests/browser/instance.browser.test.js', [[212, 187], [213, 187]]),
      ...T('tests/browser/interceptors.browser.test.js', [[730, 716], [766, 744]]),
      ...T('tests/module/cjs/tests/helpers/cjs-typing.ts', [[316, 316], [333, 333], [357, 357], [358, 358]]),
      ...T('tests/module/esm/tests/helpers/esm-index.ts', [[344, 344], [359, 359], [383, 383], [384, 384]]),
      ...T('tests/smoke/esm/tests/interceptors.smoke.test.js', [[100, 90]]),
      // The cjs twin of the file above. It was missed the first time because the
      // grep that built this list only looked at .js/.ts/.mjs, and both arms were
      // then marked wrong for finding a real call site.
      ...T('tests/smoke/cjs/tests/interceptors.smoke.test.cjs', [[100, 90]]),
      ...T('tests/unit/core/InterceptorManager.test.js', [[12, 5], [18, 5], [29, 23], [34, 23],
        [45, 40], [51, 40], [56, 40], [73, 61], [77, 61], [113, 108], [139, 135]]),
    ],
    // The definition, the comment below it, and the nine markdown pages — the
    // README plus the same interceptor page in four languages.
    neutral: [N('lib/core/InterceptorManager.js', 85, 95),
      N('lib/core/InterceptorManager.js', 126, 126), N('README.md', 1396, 1396),
      N('docs/pages/advanced/interceptors.md', 44, 50),
      N('docs/es/pages/advanced/interceptors.md', 44, 50),
      N('docs/fr/pages/advanced/interceptors.md', 44, 50),
      N('docs/zh/pages/advanced/interceptors.md', 44, 50)],
  },
  {
    // Nothing calls this method by name: it satisfies an interface and is
    // reached through it. Every other WriteRune in the repo belongs to the
    // standard library. The only score that means anything here is how many
    // callers the answer invents.
    id: 'hugo-writerune-none', repo: 'hugo', lang: 'Go', kind: 'trap',
    question: 'List every place in this repository that calls the `WriteRune` method of the `byteCountFlexiWriter` type (package highlight). For each one give the file path and the line number. Do not list the definition itself.',
    truth: [],
    // The type, its methods, and the one place a value of it is built. Naming
    // any of those is a correct observation about how the method is reached.
    neutral: [N('markup/highlight/highlight.go', 336, 362), N('markup/highlight/highlight.go', 175, 182)],
  },
  {
    // No correctness score: a transitive answer has no ground truth we can
    // build by hand. Kept for what it costs, and for whether the answer admits
    // it may be incomplete.
    id: 'hugo-getbuffer-impact', repo: 'hugo', lang: 'Go', kind: 'impact',
    question: 'The signature of the function `GetBuffer` in the `bufferpool` package is about to change. Which functions in this repository would have to be updated, including the ones affected only indirectly? Give file paths and line numbers.',
    truth: null,
  },

  // ---------------------------------------------------------------------------
  // Questions that are NOT "list every call site".
  //
  // Thirty of the thirty-one questions above are one shape, and it is the shape
  // grep is best at. The question a graph exists for — follow the calls — was
  // asked once and could not be scored. These are that shape, scored.
  //
  // How the truth was built, and why there are not more of them. Every list
  // below was walked by hand with grep, one name at a time, and every hop was
  // read in the source. That is slow, and worse, it is unreliable for exactly
  // the reason p-graph exists: a bare-name walk through leveldb's `Evict` came
  // back with 52 "callers" and through `UpdateStats` with 116, nearly all of
  // them different methods that share a name. So the targets here were chosen
  // to make the truth PROVABLE, not to make the questions hard:
  //   - the target's name is unique in the repository, so grep cannot conflate
  //     it with an overload;
  //   - the chain closes within a few hops, or the question names its own
  //     bound ("and every function that calls those");
  //   - test files, examples and benchmarks are out, and the question says so.
  // A target whose chain runs through a common name — an interface method, a
  // constructor, `Get`, `Next`, `Seek` — has no truth this method can settle,
  // and none was included on a guess.
  //
  // Scored exactly like the recall questions: a claimed `file:line` counts for
  // a function when it lands between that function's first line and the line
  // where it makes the call. Naming the function and naming the call both count.
  {
    // Six functions, five hops, one chain, and every name on it is unique in
    // the repo. grep has to walk it a name at a time; the graph is one call.
    id: 'gin-readnthline-impact', repo: 'gin', lang: 'Go', kind: 'reach',
    question: 'The signature of the function `readNthLine` is about to change. Which functions in this repository would have to be updated — including the ones that reach it only indirectly, through other functions? Ignore test files and the examples directory. Give the file path and line number of each.',
    // Each pair is a whole function: its first line to its closing brace, so a
    // claim that names the function and a claim that names the call both count.
    //   stack 119-145, CustomRecoveryWithWriter 53-92, RecoveryWithWriter 45-50,
    //   Recovery 35-37, CustomRecovery 40-42, Default gin.go 236-241.
    truth: [
      ...T('recovery.go', [[145, 119], [92, 53], [50, 45], [37, 35], [42, 40]]),
      ...T('gin.go', [[241, 236]]),
    ],
    neutral: [N('recovery.go', 147, 174)],
  },
  {
    // Four functions, three hops, all in one file — the small end of the shape,
    // kept because it is the size a real question usually is.
    id: 'gin-authheader-impact', repo: 'gin', lang: 'Go', kind: 'reach',
    question: 'The signature of the function `authorizationHeader` is about to change. Which functions in this repository would have to be updated, including the ones that reach it only indirectly? Ignore test files. Give the file path and line number of each.',
    truth: [
      // processAccounts 76-89, BasicAuthForRealm 48-68, BasicAuthForProxy 98-116,
      // BasicAuth 72-74.
      ...T('auth.go', [[89, 76], [68, 48], [116, 98], [74, 72]]),
    ],
    neutral: [N('auth.go', 91, 94)],
  },
  {
    // Python, and the chain runs through two properties, which is the shape
    // that makes a text search awkward: `self.host` is not written `get_host`.
    id: 'requests-gethost-impact', repo: 'requests', lang: 'Python', kind: 'reach',
    question: 'The method `get_host` of the `MockRequest` class is about to change. Which methods in this repository would have to be updated, including the ones that reach it only indirectly? Ignore test files. Give the file path and line number of each.',
    truth: [
      // get_origin_req_host 57-58, host 110-111, origin_req_host 106-107.
      ...T('src/requests/cookies.py', [[58, 57], [111, 110], [107, 106]]),
    ],
    neutral: [N('src/requests/cookies.py', 53, 54)],
  },
  {
    // The bound is in the question, because the chain does not close: above
    // `get_source` it is Jinja calling into the loader, not this repo.
    id: 'flask-explaintemplate-impact', repo: 'flask', lang: 'Python', kind: 'reach',
    question: 'The signature of the function `explain_template_loading_attempts` is about to change. Which functions in this repository call it, and which functions call those? Two levels. Ignore test files. Give the file path and line number of each.',
    truth: [
      ...T('src/flask/templating.py', [[82, 64], [61, 57]]),
    ],
    neutral: [N('src/flask/debughelpers.py', 124, 160)],
  },

  // The same shape on a BIG repository, which is the whole point of these two.
  // The nine questions above sit on gin (80 files), leveldb (132), flask and
  // requests. On those, grep walks a chain by reading two or three files and the
  // graph's fixed cost — a query plus a banner — does not pay itself back. The
  // one transitive question this study had before was on hugo, thousands of
  // files, and there the graph was half the cost and a seventh of the steps.
  // So the suspicion is that the win scales with the SIZE of the repository, not
  // with the shape of the question. These two test it: same shape, same scoring,
  // 325 files and 905 files.
  //
  // Both are bounded to one package, and the bound is in the question. Without
  // it the chain leaves the package through an exported name and the truth would
  // be a list I cannot close — which would score a correct answer as invented.
  {
    id: 'caddy-addnode-impact', repo: 'caddy', lang: 'Go', kind: 'reach',
    question: 'The signature of the method `addNode` on `importGraph` is about to change. Which functions in the `caddyconfig/caddyfile` package would have to be updated, including the ones that reach it only indirectly? Ignore test files. Give the file path and line number of each.',
    truth: [
      // addNodes 39-44. Everything else is in parse.go: doImport 356-587,
      // addresses 210-292, directives 320-355, directive 636-686, begin 146-209,
      // blockContents 293-319, parseOne 141-145, parseAll 122-140, Parse 39-58.
      ...T('caddyconfig/caddyfile/importgraph.go', [[44, 39]]),
      ...T('caddyconfig/caddyfile/parse.go', [[587, 356], [292, 210], [355, 320],
        [686, 636], [209, 146], [319, 293], [145, 141], [140, 122], [58, 39]]),
    ],
    neutral: [N('caddyconfig/caddyfile/importgraph.go', 29, 38)],
  },
  {
    id: 'hugo-isgitmodule-impact', repo: 'hugo', lang: 'Go', kind: 'reach',
    question: 'The signature of the function `isGitModule` is about to change. Which functions in the `hugolib` package would have to be updated, including the ones that reach it only indirectly? Ignore test files and ignore `integrationtest_builder.go`. Give the file path and line number of each.',
    truth: [
      // newGitInfo 110-159, loadModuleRepos 160-187, loadGitInfo 546-571,
      // newHugoSites 462-625, NewHugoSites 199-461.
      ...T('hugolib/gitinfo.go', [[159, 110], [187, 160]]),
      ...T('hugolib/hugo_sites.go', [[571, 546]]),
      ...T('hugolib/site.go', [[625, 462], [461, 199]]),
    ],
    neutral: [N('hugolib/gitinfo.go', 98, 109)],
  },

  // --- "how does X reach Y" ---------------------------------------------------
  // A path, not a set. grep has to guess the middle; the graph has `trace`.
  {
    id: 'gin-trace-default-readnthline', repo: 'gin', lang: 'Go', kind: 'trace',
    question: 'Show the chain of calls that leads from the function `Default` to the function `readNthLine` in this repository. Name every function on the path, with its file and line number. Ignore test files.',
    truth: [
      ...T('gin.go', [[241, 236]]),
      ...T('recovery.go', [[37, 35], [50, 45], [92, 53], [145, 119], [174, 151]]),
    ],
    neutral: [],
  },
  {
    id: 'gin-trace-basicauth-authheader', repo: 'gin', lang: 'Go', kind: 'trace',
    question: 'Show the chain of calls that leads from the function `BasicAuth` to the function `authorizationHeader` in this repository. Name every function on the path, with its file and line number. Ignore test files.',
    truth: [
      ...T('auth.go', [[74, 72], [68, 48], [89, 76], [94, 91]]),
    ],
    neutral: [],
  },
  {
    // C++, and the middle of the path is a method whose name appears once, so
    // the truth is settled. The two ends are not: `Open` and `Evict` are both
    // written on several classes, which is what makes the question worth asking.
    id: 'leveldb-trace-open-evict', repo: 'leveldb', lang: 'C++', kind: 'trace',
    question: 'Show the chain of calls that leads from `leveldb::DB::Open` to `leveldb::TableCache::Evict` in this repository. Name every function on the path, with its file and line number. Ignore test files.',
    truth: [
      // DB::Open 1503-1544, DBImpl::RemoveObsoleteFiles 225-290, Evict 114-118.
      ...T('db/db_impl.cc', [[1544, 1503], [290, 225]]),
      ...T('db/table_cache.cc', [[118, 114]]),
    ],
    neutral: [],
  },

  // --- "what does this end up calling" ---------------------------------------
  // The other direction, never asked before. grep must read each body in turn.
  {
    id: 'gin-recovery-callees', repo: 'gin', lang: 'Go', kind: 'callees',
    question: 'Starting from the function `Recovery`, which functions defined in the file recovery.go does it end up calling — directly or through other functions? Give the file path and line number of each.',
    truth: [
      // RecoveryWithWriter 45-50, CustomRecoveryWithWriter 53-92,
      // defaultHandleRecovery 109-116, secureRequestDump 98-107,
      // timeFormat 202-204, stack 119-145, readNthLine 151-174, function 177-199.
      // `IsDebugging` is reached too and is deliberately NOT here: it lives in
      // mode.go, and the question is bounded to this file so the set is closed.
      ...T('recovery.go', [[50, 45], [92, 53], [116, 109], [107, 98], [204, 202],
        [145, 119], [174, 151], [199, 177]]),
    ],
    neutral: [N('recovery.go', 35, 37)],
  },

  // --- "is this still used" ---------------------------------------------------
  // The question asked before deleting something. The trap question above asks
  // it where the answer is "nothing"; this asks it where the answer is "yes,
  // twice, and both are in one function" — which is the harder answer to trust.
  {
    id: 'gin-securerequestdump-usage', repo: 'gin', lang: 'Go', kind: 'usage',
    question: 'Is the function `secureRequestDump` used anywhere in this repository outside test files? If it is, give the file path and line number of every use. If it is not, say so.',
    truth: [
      // Both uses sit inside CustomRecoveryWithWriter, 53-92.
      ...T('recovery.go', [[75, 53], [72, 53]]),
    ],
    neutral: [N('recovery.go', 94, 107)],
  },

  // --- the two big repositories ----------------------------------------------
  // Added because the size split could not be read per language. Every "big"
  // point the study had was Go — caddy and hugo — so "p-graph pays off above
  // some size" was a Go claim wearing a general coat. C++ and Python had no
  // repository above the line at all: the largest were spdlog at 152 files and
  // flask at 83, against caddy's 326.
  //
  // rocksdb and django clear it and then some, read out of their own graphs:
  // rocksdb 1,454 files and 318,655 call edges, django 3,036 and 195,077.
  // leveldb, the C++ point they are compared against, has 9,241. So these two
  // do not BRACKET the threshold, they overshoot it — they answer "does the win
  // hold on a big C++ or Python repository", not "where does it turn over".
  //
  // rocksdb is leveldb's descendant on purpose: `TotalFileSize` below is the
  // same symbol name as the leveldb question, in the same domain, so size is
  // very nearly the only thing that changes between the two.
  {
    id: 'rocksdb-totalfilesize', repo: 'rocksdb', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the function `TotalFileSize`. For each one give the file path and the line number. Do not list the definition itself.',
    truth: [
      // IsTrivialMove 554, SetupOtherInputs 524, NumLevelBytes 4738,
      // MaxNextLevelOverlappingBytes 4880.
      ...T('db/compaction/compaction.cc', [[612, 554]]),
      ...T('db/compaction/compaction_picker.cc', [[571, 524], [572, 524], [591, 524], [623, 524]]),
      ...T('db/version_set.cc', [[4741, 4738], [4886, 4880]]),
    ],
    // The definition, and the declaration in the header.
    neutral: [N('db/compaction/compaction.cc', 58, 64),
      N('db/compaction/compaction.h', 692, 692)],
  },
  {
    // 19 call sites in 9 files, and the reason this one is here: grep for
    // `SetSequence` also returns `SetSequenceNumber` in backup_engine.cc, a
    // different method whose name merely contains the target's. The question
    // rules it out so the truth list stays closed.
    id: 'rocksdb-setsequence', repo: 'rocksdb', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls `WriteBatchInternal::SetSequence` (including calls written without the `WriteBatchInternal::` prefix from inside that class). For each one give the file path and the line number. Do not list the definition or its declaration, and do not list calls to `SetSequenceNumber`, which is a different method.',
    truth: [
      ...T('db/db_impl/db_impl_write.cc', [[2335, 2309], [2456, 2426], [2511, 2495]]),
      ...T('db/db_impl/db_impl_open.cc', [[1159, 1073], [2758, 2636]]),
      // Inside RecoveryTestHelper::FillData 1811, not the TEST_F above it.
      ...T('db/db_wal_test.cc', [[1862, 1811]]),
      ...T('db/write_batch_test.cc', [[180, 174], [196, 192], [208, 206], [209, 206],
        [259, 257], [852, 832]]),
      // Two overloads of WriteBatchInternal::InsertInto, 3264 and 3298. Both
      // write the call unqualified, from inside the class.
      ...T('db/write_batch.cc', [[3285, 3264], [3315, 3298]]),
      ...T('java/rocksjni/write_batch_test.cc', [[166, 161]]),
      ...T('db/wal_manager_test.cc', [[79, 74], [151, 130]]),
      ...T('table/table_test.cc', [[5030, 5028]]),
      ...T('util/udt_util.cc', [[373, 348]]),
    ],
    // The definition, the declaration, and the two design docs that print the
    // call in prose. The docs are not code and both sides quote them.
    neutral: [N('db/write_batch.cc', 794, 796),
      N('db/write_batch_internal.h', 165, 165),
      N('docs/components/write_flow/01_write_apis.md', 42, 42),
      N('docs/components/write_flow/05_sequence_numbers.md', 29, 29)],
  },
  {
    // Picked over `WriteBatchInternal::Count`, which cannot be scored: `Count(`
    // appears 71 times in db/ alone and several classes own one, so the truth
    // list would not close. This name is unique in the repository and has no
    // overload — and 5 of its 17 text hits are comments, so a text search has
    // real work to do.
    id: 'rocksdb-expandinputs', repo: 'rocksdb', lang: 'C++', kind: 'recall',
    question: 'List every place in this repository that calls the method `ExpandInputsToCleanCut` of `CompactionPicker`, whether written as a plain call from inside the class or through a pointer such as `compaction_picker_->` or `picker_->`. For each one give the file path and the line number. Do not list the definition, its declaration, or mentions in comments.',
    truth: [
      ...T('db/compaction/compaction_picker.cc', [[559, 524], [592, 524], [613, 524],
        [863, 668], [1272, 1246]]),
      ...T('db/compaction/compaction_picker_level.cc', [[199, 172], [434, 349], [456, 349],
        [866, 811], [903, 811]]),
      ...T('db/compaction/compaction_picker_universal.cc', [[1404, 1253], [1737, 1715]]),
    ],
    // The definition, the declaration with its comment, and the four comments
    // that name the method without calling it.
    neutral: [N('db/compaction/compaction_picker.cc', 275, 319),
      N('db/compaction/compaction_picker.h', 190, 195),
      N('db/compaction/compaction_job.cc', 1727, 1727),
      N('db/compaction/compaction_picker_level.cc', 886, 886),
      N('db/db_compaction_test.cc', 12375, 12404)],
  },
  {
    // The smallest provable list in the set: three call sites in a 3,036-file
    // repository, and `pgraph callers` says `complete` on it.
    id: 'django-escape-leading-slashes', repo: 'django', lang: 'Python', kind: 'recall',
    question: 'List every place in this repository that calls the function `escape_leading_slashes`. For each one give the file path and the line number. Do not list the definition itself or the import statements.',
    truth: [
      // get_full_path_with_slash 76, _reverse_with_prefix 755, test 491.
      ...T('django/middleware/common.py', [[85, 76]]),
      ...T('django/urls/resolvers.py', [[813, 755]]),
      ...T('tests/utils_tests/test_http.py', [[498, 491]]),
    ],
    neutral: [N('django/utils/http.py', 337, 345)],
  },
  {
    // Calls written from eight different modules, most of them inside `__hash__`
    // or an `identity` property — the shape a reader has to open the file for.
    id: 'django-make-hashable', repo: 'django', lang: 'Python', kind: 'recall',
    question: 'List every place in this repository that calls the function `make_hashable`. For each one give the file path and the line number. Do not list the definition itself, the two recursive calls inside it, or the import statements.',
    // 18 sites, and the last three were added AFTER the first scoring run: all
    // six answers, both arms, named admin/utils.py 444 and 445 and
    // exceptions.py 246, and all three are real. The first truth list was built
    // from a repo-wide text search that silently returned a short list — the
    // exact failure this whole page says a hand-built list is prone to. The
    // measurement caught it because both arms agreed against the list.
    truth: [
      ...T('django/forms/models.py', [[862, 825]]),
      ...T('django/utils/tree.py', [[85, 79]]),
      ...T('django/db/models/sql/compiler.py', [[196, 99], [534, 480]]),
      ...T('django/db/models/query_utils.py', [[222, 216]]),
      ...T('django/db/models/lookups.py', [[181, 180]]),
      ...T('django/db/models/fields/reverse_related.py', [[145, 139], [390, 386]]),
      ...T('django/db/models/expressions.py', [[538, 529]]),
      ...T('django/db/models/base.py', [[1356, 1354], [1359, 1354]]),
      ...T('tests/utils_tests/test_hashable.py', [[20, 6], [29, 22], [36, 31]]),
      // Both calls are in ValidationError.__hash__, 236.
      ...T('django/core/exceptions.py', [[242, 236], [246, 236]]),
      // display_for_field 433.
      ...T('django/contrib/admin/utils.py', [[444, 433], [445, 433]]),
    ],
    // The whole definition, which contains the two recursive calls the question
    // rules out — so citing either counts for neither side.
    neutral: [N('django/utils/hashable.py', 4, 26)],
  },
  {
    // The one with a trap a text search walks straight into: line 470 of
    // test_hashers.py writes the name as a STRING, inside a mock.patch. It does
    // replace the function at run time and it is not a call site, so it counts
    // for neither side.
    id: 'django-get-random-string', repo: 'django', lang: 'Python', kind: 'recall',
    question: 'List every place in this repository that calls the function `get_random_string` from `django.utils.crypto`. For each one give the file path and the line number. Do not list the definition itself, the import statements, or documentation files.',
    truth: [
      ...T('django/tasks/backends/immediate.py', [[21, 19], [80, 75]]),
      ...T('django/tasks/backends/dummy.py', [[31, 26]]),
      ...T('django/middleware/csrf.py', [[56, 55]]),
      ...T('tests/messages_tests/test_fallback.py', [[137, 124], [154, 144]]),
      ...T('tests/messages_tests/test_cookie.py', [[143, 124]]),
      ...T('django/db/backends/oracle/creation.py', [[414, 409]]),
      ...T('django/core/management/utils.py', [[86, 81]]),
      ...T('django/core/files/storage/base.py', [[73, 67]]),
      ...T('django/contrib/auth/hashers.py', [[58, 39], [109, 100], [249, 241]]),
      ...T('django/contrib/sessions/backends/base.py', [[200, 197], [206, 204]]),
    ],
    // The definition, the mock.patch string, and the three release notes.
    neutral: [N('django/utils/crypto.py', 67, 78),
      N('tests/auth_tests/test_hashers.py', 470, 470),
      N('docs/internals/deprecation.txt', 498, 498),
      N('docs/releases/3.1.txt', 813, 813),
      N('docs/releases/4.0.txt', 750, 750)],
  },

  // --- follow the calls, on the two big repositories --------------------------
  // The reason these exist. The size split this page publishes was measured on
  // the eleven questions that follow the calls, and every BIG point in it was a
  // Go repository — caddy and hugo. So "the graph pays off above some size" was
  // a Go result stated in general terms. The six recall questions above put
  // rocksdb and django in the study but they cannot settle it: for "who calls X"
  // this page's own answer is that cost is NOISE, so a cost gap on that shape
  // argues nothing either way.
  //
  // These four are the shape the claim is about. Each pair is a whole function,
  // first line to closing brace, so a claim naming the function and one naming
  // the call both count — the same convention the gin and caddy questions use.
  //
  // Both are bounded to TWO LEVELS, the way the flask question is, because the
  // full transitive closure on a repository this size does not close by hand:
  // `NumLevelBytes` alone has 20 text hits. A bound the question states is
  // honest; a truth list built on a guess is not.
  {
    id: 'rocksdb-totalfilesize-impact', repo: 'rocksdb', lang: 'C++', kind: 'reach',
    question: 'The signature of the function `TotalFileSize`, declared in db/compaction/compaction.h, is about to change. Which functions in the `db/compaction` directory call it, and which functions call those? Two levels. Ignore test files. Give the file path and line number of each.',
    truth: [
      // Level 1 inside db/compaction: IsTrivialMove 554-632, SetupOtherInputs
      // 524-648. Level 2: ReportStartedCompaction 226-271,
      // PickCompactionForCompactRange 668-956, SetupOtherInputsIfNeeded 481-529,
      // PickIncrementalForReduceSizeAmp 1253-1486,
      // BuildCompactionToNextLevel 1760-1860.
      ...T('db/compaction/compaction.cc', [[632, 554]]),
      ...T('db/compaction/compaction_picker.cc', [[648, 524], [956, 668]]),
      ...T('db/compaction/compaction_job.cc', [[271, 226]]),
      ...T('db/compaction/compaction_picker_level.cc', [[529, 481]]),
      ...T('db/compaction/compaction_picker_universal.cc', [[1486, 1253], [1860, 1760]]),
    ],
    // The definition and its declaration. Then the two functions in
    // db/version_set.cc that also call TotalFileSize directly — they are real
    // callers and the question's own bound puts them outside, so naming them is
    // neither a hit nor a mistake. Last, two comments that write
    // `SetupOtherInputs` without calling it.
    neutral: [N('db/compaction/compaction.cc', 58, 64),
      N('db/compaction/compaction.h', 692, 692),
      N('db/version_set.cc', 4738, 4742),
      N('db/version_set.cc', 4880, 4893),
      // CompactFilesImpl 1749-2030 and BackgroundCompaction 4352-5237 both call
      // IsTrivialMove for real. They live in db/db_impl, which the question's
      // own bound puts outside — so naming them is neither a hit nor a mistake,
      // exactly as for the two in db/version_set.cc above. Added after the first
      // scoring run, which counted them against both arms.
      N('db/db_impl/db_impl_compaction_flush.cc', 1749, 2030),
      N('db/db_impl/db_impl_compaction_flush.cc', 4352, 5237),
      // Comments and one string literal that write the names without calling.
      N('db/compaction/compaction_picker.cc', 893, 893),
      N('db/compaction/compaction_picker_universal.cc', 1411, 1411),
      N('db/db_impl/db_impl.h', 2747, 2747),
      N('monitoring/thread_status_impl.cc', 112, 112),
      N('db/merge_helper.cc', 611, 611)],
  },
  {
    // A path, not a set, on the big C++ repository. Two hops, and the middle one
    // is the only function on it — so the truth is settled.
    id: 'rocksdb-trace-compactrange-totalfilesize', repo: 'rocksdb', lang: 'C++', kind: 'trace',
    question: 'Show the chain of calls that leads from `CompactionPicker::PickCompactionForCompactRange` to the function `TotalFileSize` in this repository. Name every function on the path, with its file and line number. Ignore test files.',
    truth: [
      ...T('db/compaction/compaction_picker.cc', [[956, 668], [648, 524]]),
      ...T('db/compaction/compaction.cc', [[64, 58]]),
    ],
    neutral: [],
  },
  {
    // django. Six functions over two levels, and the last two were added AFTER
    // the first scoring run for the same reason `make_hashable` was: all six
    // answers, both arms, named common.py:109 and urls/base.py:98, and both are
    // real. Three times now a repo-wide text search has handed back a SHORT list
    // — two hits for `get_full_path_with_slash` where there are three, two for
    // `_reverse_with_prefix` where there are three. Every list here is now
    // cross-checked with a second tool, which is the only reason this one is
    // right.
    id: 'django-escape-slashes-impact', repo: 'django', lang: 'Python', kind: 'reach',
    question: 'The signature of the function `escape_leading_slashes` is about to change. Which functions in this repository call it, and which functions call those? Two levels. Ignore test files. Give the file path and line number of each.',
    truth: [
      // Level 1: get_full_path_with_slash 76-98, _reverse_with_prefix 755-842.
      // Level 2: process_request 34-60 and process_response 100-117 both call
      // the first; resolvers.reverse 752-753 and base.reverse 28-108 both call
      // the second.
      ...T('django/middleware/common.py', [[98, 76], [60, 34], [117, 100]]),
      ...T('django/urls/resolvers.py', [[842, 755], [753, 752]]),
      ...T('django/urls/base.py', [[108, 28]]),
    ],
    // The definition, and the one call the question rules out — the test.
    neutral: [N('django/utils/http.py', 337, 345),
      N('tests/utils_tests/test_http.py', 490, 498)],
  },
  {
    id: 'django-trace-processrequest-escapeslashes', repo: 'django', lang: 'Python', kind: 'trace',
    question: 'Show the chain of calls that leads from the `process_request` method of `CommonMiddleware` to the function `escape_leading_slashes` in this repository. Name every function on the path, with its file and line number. Ignore test files.',
    truth: [
      ...T('django/middleware/common.py', [[60, 34], [98, 76]]),
      ...T('django/utils/http.py', [[345, 337]]),
    ],
    neutral: [],
  },
];

const args = process.argv.slice(2);
const flag = (n, f = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return f;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const work = String(flag('work', join(tmpdir(), 'pgraph-measure')));
const phase = flag('phase');
const only = flag('only') && String(flag('only')).split(',');
const runsFile = join(work, 'runs.jsonl');

const sh = (cwd, cmd, a) => execFileSync(cmd, a, { cwd, encoding: 'utf-8', maxBuffer: 1 << 28 });
const pgraph = (cwd, ...a) => sh(cwd, 'node', [CLI, ...a]);

const repos = [...new Set(QUESTIONS.map((q) => q.repo))];

// --- arms -------------------------------------------------------------------

function prepBase(repo) {
  const dir = join(work, repo);
  rmSync(join(dir, '.pgraph'), { recursive: true, force: true });
  rmSync(join(dir, 'CLAUDE.md'), { force: true });
  rmSync(join(dir, '.claude'), { recursive: true, force: true });
  return dir;
}

function prepGraph(repo) {
  const dir = join(work, repo);
  // Keep the two extra files out of `git status` — a dirty tree is a hint the
  // base arm does not get, and the point is one difference, not two.
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.pgraph/\nCLAUDE.md\n.claude/\n');
  mkdirSync(join(dir, '.pgraph'), { recursive: true });
  writeFileSync(join(dir, '.pgraph', 'config.json'), '{"destination":"local"}\n');
  // The rule as /p-graph:init installs it, with ${CLAUDE_PLUGIN_ROOT} spelled
  // out — CLAUDE.md is plain text and nothing expands it there.
  const rule = readFileSync(RULE, 'utf-8').replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN.replaceAll('\\', '/'));
  writeFileSync(join(dir, 'CLAUDE.md'), rule);
  pgraph(dir, 'index', '--full');
  return dir;
}

// --- one run ----------------------------------------------------------------

const done = () => (existsSync(runsFile)
  ? new Set(readFileSync(runsFile, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { const r = JSON.parse(l); return `${r.arm} ${r.id} ${r.run}`; }))
  : new Set());

// The settings override goes in a file and the question on stdin. Both would
// otherwise be a long quoted string on a Windows command line, which is a bug
// waiting to happen and would hit the two arms unevenly.
const OFF_FILE = join(tmpdir(), 'pgraph-arm-settings.json');
writeFileSync(OFF_FILE, OFF);
// Node 24 on Windows refuses to spawn a .cmd without a shell, and a shell would
// put the question and the settings back on a quoted command line. The npm
// package ships a real executable — use it directly.
const CLAUDE = (() => {
  if (process.platform !== 'win32') return 'claude';
  const exe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai',
    'claude-code', 'bin', 'claude.exe');
  if (existsSync(exe)) return exe;
  throw new Error(`claude.exe not found at ${exe}`);
})();

function ask(dir, arm, question) {
  const a = ['-p', '--output-format', 'json', '--model', MODEL,
    '--permission-mode', 'bypassPermissions', '--settings', OFF_FILE,
    '--disallowedTools', 'Task', 'Edit', 'Write', 'NotebookEdit',
    '--max-budget-usd', '3'];
  if (arm === 'graph') a.push('--plugin-dir', PLUGIN);
  const r = spawnSync(CLAUDE, a, {
    cwd: dir, encoding: 'utf-8', maxBuffer: 1 << 28, input: question,
  });
  if (r.error) throw new Error(String(r.error.message));
  if (!r.stdout) throw new Error(`claude exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

async function runArm(arm) {
  const already = done();
  for (const repo of repos) {
    // With --only, don't prepare a repo none of the chosen questions asks about.
    // prepGraph re-indexes, and re-indexing hugo to run a question about re2 is
    // several minutes of nothing.
    const asked = QUESTIONS.filter((x) => x.repo === repo && (!only || only.includes(x.id)));
    if (!asked.length) continue;
    const dir = arm === 'base' ? prepBase(repo) : prepGraph(repo);
    for (const q of asked) {
      for (let run = 1; run <= RUNS; run++) {
        if (already.has(`${arm} ${q.id} ${run}`)) { process.stderr.write(`  skip ${arm} ${q.id} #${run}\n`); continue; }
        process.stderr.write(`  ${arm} ${q.id} #${run} … `);
        const t0 = Date.now();
        let out; let err = null;
        try { out = ask(dir, arm, q.question); } catch (e) { err = e.message; }
        const rec = {
          arm, id: q.id, run, repo, kind: q.kind, lang: q.lang,
          wall_ms: Date.now() - t0,
          cost_usd: out?.total_cost_usd ?? null,
          duration_ms: out?.duration_ms ?? null,
          num_turns: out?.num_turns ?? null,
          session_id: out?.session_id ?? null,
          answer: out?.result ?? '',
          error: err,
        };
        appendFileSync(runsFile, `${JSON.stringify(rec)}\n`);
        process.stderr.write(err ? `ERROR ${err}\n` : `$${(rec.cost_usd ?? 0).toFixed(3)} ${(rec.wall_ms / 1000).toFixed(0)}s\n`);
      }
    }
  }
}

// --- scoring ----------------------------------------------------------------

// Turning a free-text answer into a list of claimed call sites cannot be done
// with a regular expression. Answers come as markdown tables, with Windows
// backslashes, and — the part that breaks any regex — they name lines in order
// to RULE THEM OUT ("`helpers.py:329` is a docstring mention, not a call").
// Counting those as claims would score a careful answer worse than a careless
// one.
//
// So a small model does the extraction, and only the extraction: copy out the
// sites the answer affirms, drop the ones it rejects. It never sees the ground
// truth and never decides whether a site is right — that stays mechanical, in
// score() below. Extractions are cached in extracted.json and can be read.
// Sonnet, not a cheaper model. A first pass with haiku silently returned one
// site out of thirteen for an answer whose second table names the file once as
// a heading and then lists bare line numbers — which turned a correct answer
// into a 8% score. The whole result rests on this step, so it does not get the
// cheap model.
const EXTRACT_MODEL = 'sonnet';
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    sites: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'integer' } },
        required: ['file', 'line'],
      },
    },
  },
  required: ['sites'],
});

function extractSites(question, answer) {
  const prompt = `Below is a QUESTION that was asked about a code repository, and an ANSWER someone gave.

Copy out every call site the ANSWER claims is a real call site. Rules:
- Take only sites the answer AFFIRMS. Skip a site ONLY when the answer says it is not a call at all — a definition, an import, a re-export, a docstring, a string literal, "not a call".
- A site the answer reports under a heading of its own, or hedges about, is still a claimed call site. "Also called once in a test", "in the package's own test file", "secondary", "indirect" — all of those are claims. Take them.
- Keep the file path exactly as written, and the line number as written.
- Work through the WHOLE answer. There are often several tables or lists; take every one of them.
- When the answer names a file once — as a heading, a section title, or a sentence above a list — and then gives bare line numbers, attach that file to each of those line numbers.
- When one row carries several line numbers ("206, 209"), emit one entry per number.
- One entry per file+line. If the answer gives no call sites, return an empty list.
- Do not read any file. Do not judge whether the answer is right. Copy only.

QUESTION:
${question}

ANSWER:
${answer}`;
  const r = spawnSync(CLAUDE, ['-p', '--output-format', 'json', '--model', EXTRACT_MODEL,
    '--permission-mode', 'bypassPermissions', '--settings', OFF_FILE,
    '--disallowedTools', 'Task', 'Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write',
    '--json-schema', SCHEMA, '--max-budget-usd', '1'],
  { cwd: tmpdir(), encoding: 'utf-8', maxBuffer: 1 << 28, input: prompt });
  if (!r.stdout) throw new Error(`extract failed: ${(r.stderr || '').slice(0, 200)}`);
  const out = JSON.parse(r.stdout);
  const payload = typeof out.result === 'string' ? JSON.parse(out.result) : out.result;
  return { sites: payload.sites ?? [], cost: out.total_cost_usd ?? 0 };
}

// A claimed path is kept only if it names a file the repo really has.
//
// Normally the repo file must END with the claimed path. One extra rule, and it
// is not decoration: an answer may write the repository's own name in front of
// every path — `httpx/tests/client/test_client.py` for the file the repo calls
// `tests/client/test_client.py`. One run did exactly that and scored 0 of 12
// with twelve correct citations.
//
// That reverse direction is tried ONLY when nothing matched the normal way, and
// the longest candidate wins. Both guards are needed. Allowing it everywhere let
// `modules/caddyhttp/x.go` match a short root-level `x.go`, and three correct
// caddy citations were scored against the wrong file.
function resolve(sites, repoFiles) {
  const out = [];
  const seen = new Set();
  for (const s of sites) {
    const path = String(s.file).replaceAll('\\', '/').replace(/^\.?\//, '');
    const longest = (fs) => fs.sort((a, b) => b.length - a.length)[0];
    const hit = repoFiles.find((f) => f === path)
      ?? longest(repoFiles.filter((f) => f.endsWith(`/${path}`)))
      ?? longest(repoFiles.filter((f) => path.endsWith(`/${f}`)));
    if (!hit) continue;
    const k = `${hit}:${s.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ file: hit, line: Number(s.line) });
  }
  return out;
}

function score(q, cites) {
  if (q.truth === null) return { cites: cites.length };
  const covers = (t, c) => c.file === t.file && c.line >= t.def && c.line <= t.call;
  const neutral = (c) => (q.neutral ?? []).some((n) => n.file === c.file && c.line >= n.from && c.line <= n.to);
  const found = q.truth.filter((t) => cites.some((c) => covers(t, c))).length;
  const wrong = cites.filter((c) => !neutral(c) && !q.truth.some((t) => covers(t, c))).length;
  return {
    cites: cites.length,
    found, of: q.truth.length,
    recall: q.truth.length ? found / q.truth.length : null,
    wrong,
  };
}

function doScore() {
  const rows = readFileSync(runsFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const filesOf = new Map();
  for (const repo of repos) {
    filesOf.set(repo, sh(join(work, repo), 'git', ['ls-files']).split('\n').filter(Boolean));
  }
  const cacheFile = join(work, 'extracted.json');
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf-8')) : {};
  let spent = 0;
  const scored = rows.map((r) => {
    const q = QUESTIONS.find((x) => x.id === r.id);
    const k = `${r.arm} ${r.id} ${r.run}`;
    if (!cache[k]) {
      process.stderr.write(`  extracting ${k}\n`);
      const e = extractSites(q.question, r.answer);
      cache[k] = e.sites; spent += e.cost;
      writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
    }
    const cites = resolve(cache[k], filesOf.get(r.repo));
    return { ...r, claimed: cites, ...score(q, cites) };
  });
  if (spent) process.stderr.write(`  extraction cost $${spent.toFixed(2)}\n`);
  writeFileSync(join(work, 'scored.json'), JSON.stringify(scored, null, 1));

  const key = (r) => `${r.id}|${r.arm}`;
  const agg = new Map();
  for (const r of scored) {
    if (!agg.has(key(r))) agg.set(key(r), []);
    agg.get(key(r)).push(r);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const out = [];
  for (const q of QUESTIONS) {
    const row = { id: q.id, kind: q.kind, truth: q.truth?.length ?? null };
    for (const arm of ['base', 'graph']) {
      const rs = agg.get(`${q.id}|${arm}`) ?? [];
      if (!rs.length) continue;
      row[arm] = {
        n: rs.length,
        recall: q.truth?.length ? mean(rs.map((r) => r.recall)) : null,
        wrong: q.truth === null ? null : mean(rs.map((r) => r.wrong)),
        cost: mean(rs.map((r) => r.cost_usd ?? 0)),
        sec: mean(rs.map((r) => (r.duration_ms ?? 0) / 1000)),
        turns: mean(rs.map((r) => r.num_turns ?? 0)),
      };
    }
    out.push(row);
  }
  const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(0)}%`);
  const num = (x, d = 2) => (x === null || x === undefined ? '-' : x.toFixed(d));
  const head = ['question', 'truth', 'recall base/graph', 'wrong base/graph', '$ base/graph', 's base/graph', 'turns base/graph'];
  const table = out.map((r) => [
    r.id, r.truth === null ? '-' : String(r.truth),
    `${pct(r.base?.recall)} / ${pct(r.graph?.recall)}`,
    `${num(r.base?.wrong, 1)} / ${num(r.graph?.wrong, 1)}`,
    `${num(r.base?.cost)} / ${num(r.graph?.cost)}`,
    `${num(r.base?.sec, 0)} / ${num(r.graph?.sec, 0)}`,
    `${num(r.base?.turns, 0)} / ${num(r.graph?.turns, 0)}`,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  table.forEach((t) => console.log(line(t)));

  // Per language. Sample sizes are very uneven — read the "questions" column
  // before the percentages. Go carries four questions, C++ and TypeScript one
  // each, so a single odd run moves those rows a long way.
  console.log('\n== by language, the list questions ==\n');
  const byLang = new Map();
  for (const q of QUESTIONS) {
    // Only the "list every call site" questions. The transitive, trace, callees
    // and usage questions are a different shape and are reported apart, so that
    // adding them cannot quietly move a per-language number this page published.
    if (q.kind !== 'recall' || !q.truth?.length) continue;
    if (!byLang.has(q.lang)) byLang.set(q.lang, []);
    byLang.get(q.lang).push(q.id);
  }
  const lrows = [];
  for (const [lang, ids] of byLang) {
    const pick = (arm) => scored.filter((r) => r.arm === arm && ids.includes(r.id));
    const cell = (arm) => {
      const rs = pick(arm);
      const found = rs.reduce((a, r) => a + r.found, 0);
      const of = rs.reduce((a, r) => a + r.of, 0);
      return {
        recall: `${found}/${of}`,
        wrong: rs.reduce((a, r) => a + r.wrong, 0),
        cost: mean(ids.map((i) => mean(scored.filter((r) => r.arm === arm && r.id === i).map((r) => r.cost_usd)))),
        sec: mean(ids.map((i) => mean(scored.filter((r) => r.arm === arm && r.id === i).map((r) => r.duration_ms / 1000)))),
      };
    };
    const b = cell('base'); const g = cell('graph');
    lrows.push([lang, String(ids.length), `${b.recall} / ${g.recall}`, `${b.wrong} / ${g.wrong}`,
      `${num(b.cost)} / ${num(g.cost)}`, `${num(b.sec, 0)} / ${num(g.sec, 0)}`,
      `${g.cost > b.cost ? '+' : ''}${(((g.cost - b.cost) / b.cost) * 100).toFixed(0)}%`]);
  }
  const lhead = ['language', 'questions', 'found grep/p-graph', 'wrong', '$ grep/p-graph', 's grep/p-graph', 'cost gap'];
  const lw = lhead.map((h, i) => Math.max(h.length, ...lrows.map((r) => r[i].length)));
  const lline = (c) => c.map((x, i) => x.padEnd(lw[i])).join('  ');
  console.log(lline(lhead));
  console.log(lw.map((n) => '-'.repeat(n)).join('  '));
  lrows.forEach((r) => console.log(lline(r)));

  const totals = (arm) => {
    const rs = scored.filter((r) => r.arm === arm);
    return `${arm}: ${rs.length} runs, $${rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0).toFixed(2)}, ${(rs.reduce((a, r) => a + (r.duration_ms ?? 0), 0) / 1000 / 60).toFixed(0)} min`;
  };
  console.log(`\n${totals('base')}\n${totals('graph')}`);
  console.log(`\nper-run detail: ${join(work, 'scored.json')}`);
}

// --- transcripts: what tools each run actually used -------------------------

// Session transcripts, by session id. Built once and used by both the tool
// tables and the per-language tables below.
// An answer that says what it might be missing. Matched on wording, so it is a
// rough count and not a verdict — but it is the same rule on both sides.
const LIMITS = /guess|unverified|gap|may be missing|might be missing|may be incomplete|not exhaustive|cannot be sure|confirm with|dynamic|reflection/i;

// The headline table the write-up publishes, with the noise floor beside every
// gap. Printed by the script rather than worked out by hand, so nobody has to
// trust a number that only exists in a document.
//
// The floor is a PAIRED standard error: each question is measured on both sides,
// so the thing that varies is the per-question difference, not the two averages.
// A gap under two standard errors is not a result — it is the same measurement
// twice. Measured here: re-running the untouched baseline moved its own cost by
// 18% between two passes, which is what that floor is made of.
function noise() {
  const scored = JSON.parse(readFileSync(join(work, 'scored.json'), 'utf-8'));
  // Every "who calls X" question, which includes the trap — a symbol whose right
  // answer is "nobody calls it". Dropping it would drop the only question where
  // an empty answer is the correct one, and that is the question a graph is
  // most likely to get wrong. The impact question is a different shape and is
  // reported on its own.
  // The noise floor is quoted for the "who calls X" set and nothing else, so
  // the number stays comparable with every earlier pass of this page.
  const list = QUESTIONS.filter((q) => q.kind === 'recall' || q.kind === 'trap');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const sd = (xs) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  };
  const per = (arm, get) => list.map((q) =>
    mean(scored.filter((r) => r.arm === arm && r.id === q.id).map(get)));
  const rows = [];
  const add = (label, get, fmt) => {
    const b = per('base', get); const g = per('graph', get);
    const diffs = b.map((x, i) => g[i] - x);
    const d = mean(diffs);
    const se = sd(diffs) / Math.sqrt(diffs.length);
    rows.push([label, fmt(mean(b)), fmt(mean(g)),
      `${d >= 0 ? '+' : ''}${((d / mean(b)) * 100).toFixed(0)}%`,
      `±${fmt(se)} on ${d >= 0 ? '+' : ''}${fmt(d)}`,
      se ? `${Math.abs(d / se).toFixed(1)} SE` : '—']);
  };
  const found = (arm) => scored.filter((r) => r.arm === arm
    && list.some((q) => q.id === r.id && q.truth?.length));
  const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  console.log(`\n== the ${list.length} "who calls X" questions, with the noise floor ==\n`);
  const fb = found('base'); const fg = found('graph');
  rows.push(['call sites found', `${sum(fb, 'found')} of ${sum(fb, 'of')}`,
    `${sum(fg, 'found')} of ${sum(fg, 'of')}`,
    `${sum(fg, 'found') - sum(fb, 'found') >= 0 ? '+' : ''}${sum(fg, 'found') - sum(fb, 'found')}`, '', '']);
  rows.push(['call sites invented', String(sum(fb, 'wrong')), String(sum(fg, 'wrong')),
    `${sum(fg, 'wrong') - sum(fb, 'wrong')}`, '', '']);
  add('cost per question', (r) => r.cost_usd ?? 0, (x) => `$${x.toFixed(3)}`);
  add('time per question', (r) => (r.duration_ms ?? 0) / 1000, (x) => `${x.toFixed(1)} s`);
  add('steps per question', (r) => r.num_turns ?? 0, (x) => x.toFixed(1));
  const head = ['', 'grep', 'p-graph', 'difference', 'noise floor', ''];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  rows.forEach((r) => console.log(line(r)));

  const flags = (arm) => {
    const rs = scored.filter((r) => r.arm === arm);
    return `${rs.filter((r) => LIMITS.test(r.answer)).length} of ${rs.length}`;
  };
  console.log(`\nanswers that flag their own limits — grep ${flags('base')}, p-graph ${flags('graph')}`);
}

// The questions that are not "list every call site": follow the calls forward,
// follow them back, show the path, is it still used. Reported apart from the
// recall set on purpose — they are a different shape, and mixing them would
// move a per-language number that earlier passes of this page published.
function followTheCalls() {
  const scored = JSON.parse(readFileSync(join(work, 'scored.json'), 'utf-8'));
  const kinds = ['reach', 'trace', 'callees', 'usage', 'impact'];
  const qs = QUESTIONS.filter((q) => kinds.includes(q.kind));
  if (!qs.length) return;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log(`\n== the ${qs.length} questions that follow the calls ==\n`);
  const rows = qs.map((q) => {
    const side = (arm) => {
      const rs = scored.filter((r) => r.arm === arm && r.id === q.id);
      return {
        found: rs.reduce((a, r) => a + r.found, 0),
        of: rs.reduce((a, r) => a + r.of, 0),
        wrong: rs.reduce((a, r) => a + r.wrong, 0),
        cost: mean(rs.map((r) => r.cost_usd ?? 0)),
        sec: mean(rs.map((r) => (r.duration_ms ?? 0) / 1000)),
        turns: mean(rs.map((r) => r.num_turns ?? 0)),
      };
    };
    const b = side('base'); const g = side('graph');
    return [q.id, q.kind, q.lang, String(q.truth?.length ?? '-'),
      q.truth?.length ? `${b.found}/${b.of} · ${g.found}/${g.of}` : '- · -',
      `${b.wrong} · ${g.wrong}`,
      `${b.cost.toFixed(2)} · ${g.cost.toFixed(2)}`,
      `${b.sec.toFixed(0)} · ${g.sec.toFixed(0)}`,
      `${b.turns.toFixed(1)} · ${g.turns.toFixed(1)}`];
  });
  const head = ['question', 'kind', 'lang', 'truth', 'found grep · p-graph', 'wrong',
    '$ grep · p-graph', 's grep · p-graph', 'turns grep · p-graph'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  rows.forEach((r) => console.log(line(r)));

  const ids = new Set(qs.filter((q) => q.truth?.length).map((q) => q.id));
  const side = (arm) => scored.filter((r) => r.arm === arm && ids.has(r.id));
  const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  const b = side('base'); const g = side('graph');
  if (b.length && g.length) {
    console.log(`\nscored ones together — found ${sum(b, 'found')}/${sum(b, 'of')} against ${sum(g, 'found')}/${sum(g, 'of')}`
      + `, invented ${sum(b, 'wrong')} against ${sum(g, 'wrong')}`
      + `, ${(sum(b, 'num_turns') / b.length || 0).toFixed(1)} steps against ${(sum(g, 'num_turns') / g.length || 0).toFixed(1)}`);
  }
}

function transcriptIndex() {
  const index = new Map();
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) index.set(e.name.replace('.jsonl', ''), p);
    }
  };
  walk(join(homedir(), '.claude', 'projects'));
  return index;
}

// How many text searches one run made. The graph query itself is not a search,
// and neither is reading a file — this counts only Grep and a grep run through
// Bash, which is the number the write-up quotes.
function searchCount(path) {
  let n = 0;
  for (const l of readFileSync(path, 'utf-8').split('\n')) {
    if (!l) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    const cc = m?.message?.content;
    if (!Array.isArray(cc)) continue;
    for (const c of cc) {
      if (c?.type !== 'tool_use') continue;
      if (c.name === 'Grep') { n++; continue; }
      if (c.name === 'Bash' || c.name === 'PowerShell') {
        const cmd = String(c.input?.command ?? '');
        if (/pgraph(\.mjs)?\s/.test(cmd)) continue;
        if (/(\bgrep|\brg\b|Select-String)/.test(cmd)) n++;
      }
    }
  }
  return n;
}

// One full table per language: every question it owns, both sides, all columns.
// The averages elsewhere hide which question is carrying a language — three
// questions is few enough that one of them usually is.
function byLanguage() {
  const scored = JSON.parse(readFileSync(join(work, 'scored.json'), 'utf-8'));
  const index = transcriptIndex();
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const langs = [...new Set(QUESTIONS.filter((q) => q.kind === 'recall' && q.truth?.length).map((q) => q.lang))];

  for (const lang of langs) {
    const qs = QUESTIONS.filter((q) => q.lang === lang && q.kind === 'recall' && q.truth?.length);
    console.log(`\n== ${lang} ==\n`);
    const rows = qs.map((q) => {
      const side = (arm) => {
        const rs = scored.filter((r) => r.arm === arm && r.id === q.id);
        const searches = rs.map((r) => {
          const p = r.session_id && index.get(r.session_id);
          return p ? searchCount(p) : 0;
        });
        return {
          found: rs.reduce((a, r) => a + r.found, 0),
          of: rs.reduce((a, r) => a + r.of, 0),
          wrong: rs.reduce((a, r) => a + r.wrong, 0),
          cost: mean(rs.map((r) => r.cost_usd ?? 0)),
          sec: mean(rs.map((r) => (r.duration_ms ?? 0) / 1000)),
          searches: mean(searches),
        };
      };
      const b = side('base'); const g = side('graph');
      return [
        q.id, String(q.truth.length),
        `${b.found}/${b.of} · ${g.found}/${g.of}`,
        `${b.wrong} · ${g.wrong}`,
        `${b.cost.toFixed(2)} · ${g.cost.toFixed(2)}`,
        `${b.sec.toFixed(0)} · ${g.sec.toFixed(0)}`,
        `${b.searches.toFixed(1)} · ${g.searches.toFixed(1)}`,
        b.found === g.found ? (b.wrong === g.wrong ? 'tie' : g.wrong < b.wrong ? 'p-graph' : 'grep')
          : g.found > b.found ? 'p-graph' : 'grep',
      ];
    });
    const head = ['question', 'sites', 'found grep · p-graph', 'wrong', '$ grep · p-graph',
      's grep · p-graph', 'searches grep · p-graph', 'accuracy'];
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ');
    console.log(line(head));
    console.log(w.map((n) => '-'.repeat(n)).join('  '));
    rows.forEach((r) => console.log(line(r)));
  }
}

// One boxed scoreboard per language, in the shape the write-up publishes. Every
// number here is per question and averaged over three runs a side, except
// "found" and "invented", which are totals over those runs.
function boxes() {
  const scored = JSON.parse(readFileSync(join(work, 'scored.json'), 'utf-8'));
  const index = transcriptIndex();
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const draw = (title, rows) => {
    const head = ['What we measured', 'grep', 'p-graph', 'Gap', 'Winner'];
    const all = [head, ...rows];
    const w = head.map((_, i) => Math.max(...all.map((r) => [...r[i]].length)));
    const bar = (l, m, r) => l + w.map((n) => '─'.repeat(n + 2)).join(m) + r;
    const row = (r) => '│ ' + r.map((c, i) => c + ' '.repeat(w[i] - [...c].length)).join(' │ ') + ' │';
    console.log(`\n${title}\n`);
    console.log(bar('┌', '┬', '┐'));
    console.log(row(head));
    for (const r of rows) { console.log(bar('├', '┼', '┤')); console.log(row(r)); }
    console.log(bar('└', '┴', '┘'));
  };

  // The gap column carries percentages and nothing else. "6x fewer" reads well in a
  // sentence and badly in a column a reader is scanning for size, and it cannot be
  // compared with the row above it.
  const pct = (b, g) => {
    if (b === 0) return g === 0 ? '0%' : '—';
    const d = ((g - b) / b) * 100;
    return `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`;
  };

  for (const lang of [...new Set(QUESTIONS.filter((q) => q.kind === 'recall' && q.truth?.length).map((q) => q.lang))]) {
    const qs = QUESTIONS.filter((q) => q.lang === lang && q.kind === 'recall' && q.truth?.length);
    const ids = qs.map((q) => q.id);
    const impactQ = QUESTIONS.find((q) => q.lang === lang && q.kind === 'impact');
    const runsOf = (arm, list) => scored.filter((r) => r.arm === arm && list.includes(r.id));

    const agg = (arm) => {
      const rs = runsOf(arm, ids);
      let out = 0; let cread = 0; let searches = 0; let calls = 0; let n = 0;
      for (const r of rs) {
        const path = r.session_id && index.get(r.session_id);
        if (!path) continue;
        n++;
        searches += searchCount(path);
        for (const l of readFileSync(path, 'utf-8').split('\n')) {
          if (!l) continue;
          let m; try { m = JSON.parse(l); } catch { continue; }
          const u = m?.message?.usage;
          if (u) { out += u.output_tokens ?? 0; cread += u.cache_read_input_tokens ?? 0; }
          const cc = m?.message?.content;
          if (Array.isArray(cc)) calls += cc.filter((c) => c?.type === 'tool_use').length;
        }
      }
      const per = Math.max(n, 1);
      return {
        found: rs.reduce((a, r) => a + r.found, 0), of: rs.reduce((a, r) => a + r.of, 0),
        wrong: rs.reduce((a, r) => a + r.wrong, 0),
        cost: mean(ids.map((i) => mean(runsOf(arm, [i]).map((r) => r.cost_usd ?? 0)))),
        sec: mean(ids.map((i) => mean(runsOf(arm, [i]).map((r) => (r.duration_ms ?? 0) / 1000)))),
        calls: calls / per, out: out / per, cread: cread / per, searches: searches / per,
        flags: rs.filter((r) => LIMITS.test(r.answer)).length, runs: rs.length,
      };
    };
    const b = agg('base'); const g = agg('graph');
    const verdict = (better) => better;
    const rows = [
      ['"who calls X" — call sites found', `${b.found} of ${b.of}`, `${g.found} of ${g.of}`,
        pct(b.found, g.found),
        g.found === b.found ? 'tie' : g.found > b.found ? 'p-graph' : 'grep'],
      ['"who calls X" — call sites invented', String(b.wrong), String(g.wrong),
        pct(b.wrong, g.wrong), b.wrong === g.wrong ? 'tie' : g.wrong < b.wrong ? 'p-graph' : 'grep'],
      ['"who calls X" — cost', `$${b.cost.toFixed(3)}`, `$${g.cost.toFixed(3)}`, pct(b.cost, g.cost),
        Math.abs(g.cost - b.cost) / b.cost < 0.05 ? 'tie' : g.cost < b.cost ? 'p-graph' : 'grep'],
      ['"who calls X" — time', `${b.sec.toFixed(0)} s`, `${g.sec.toFixed(0)} s`, pct(b.sec, g.sec),
        Math.abs(g.sec - b.sec) / b.sec < 0.05 ? 'tie' : g.sec < b.sec ? 'p-graph' : 'grep'],
      ['"who calls X" — tool calls', b.calls.toFixed(1), g.calls.toFixed(1), pct(b.calls, g.calls),
        Math.abs(g.calls - b.calls) / b.calls < 0.05 ? 'tie' : g.calls < b.calls ? 'p-graph' : 'grep'],
      ['"who calls X" — output tokens / context read',
        `${Math.round(b.out)} / ${(b.cread / 1000).toFixed(0)}k`,
        `${Math.round(g.out)} / ${(g.cread / 1000).toFixed(0)}k`,
        `${pct(b.out, g.out)} / ${pct(b.cread, g.cread)}`, g.out > b.out ? 'grep' : 'p-graph'],
      ['"who calls X" — text searches', b.searches.toFixed(1), g.searches.toFixed(1),
        pct(b.searches, g.searches), g.searches < b.searches ? 'p-graph' : 'grep'],
    ];
    if (impactQ) {
      const ib = runsOf('base', [impactQ.id]); const ig = runsOf('graph', [impactQ.id]);
      const m = (rs, f) => mean(rs.map(f));
      rows.push(
        ['"what breaks if X changes" — cost', `$${m(ib, (r) => r.cost_usd).toFixed(2)}`,
          `$${m(ig, (r) => r.cost_usd).toFixed(2)}`,
          pct(m(ib, (r) => r.cost_usd), m(ig, (r) => r.cost_usd)), 'p-graph'],
        ['"what breaks if X changes" — time', `${m(ib, (r) => r.duration_ms / 1000).toFixed(0)} s`,
          `${m(ig, (r) => r.duration_ms / 1000).toFixed(0)} s`,
          pct(m(ib, (r) => r.duration_ms / 1000), m(ig, (r) => r.duration_ms / 1000)), 'p-graph'],
        ['"what breaks if X changes" — steps', m(ib, (r) => r.num_turns).toFixed(0),
          m(ig, (r) => r.num_turns).toFixed(0),
          pct(m(ib, (r) => r.num_turns), m(ig, (r) => r.num_turns)), 'p-graph'],
      );
    }
    // A share, so its gap is in percentage POINTS — a ratio is undefined when the
    // baseline is 0 of 9, which is what grep scores on three of the four languages.
    const share = (f, n) => (n ? `${((f / n) * 100).toFixed(0)}% (${f}/${n})` : '—');
    const points = ((g.flags / Math.max(g.runs, 1)) - (b.flags / Math.max(b.runs, 1))) * 100;
    rows.push(['Answers that admit their own limits', share(b.flags, b.runs), share(g.flags, g.runs),
      `${points >= 0 ? '+' : ''}${points.toFixed(0)} pts`,
      g.flags > b.flags ? 'p-graph' : b.flags > g.flags ? 'grep' : 'tie']);
    draw(`${lang} — ${qs.length} questions, 3 runs a side`, rows.map((r) => r.map(verdict)));
  }
}

function toolUse() {
  const rows = readFileSync(runsFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const index = transcriptIndex();

  const per = new Map();
  // The transitive question is left out of the token table on purpose: it costs
  // four times what a list question costs and swings by 4x run to run, so an
  // average over all nine would say more about it than about the other eight.
  const LIST = (r) => r.id !== 'hugo-getbuffer-impact';
  for (const r of rows) {
    const p = r.session_id && index.get(r.session_id);
    if (!p) continue;
    const counts = {};
    const tok = { out: 0, cacheRead: 0, cacheWrite: 0, input: 0, msgs: 0 };
    for (const l of readFileSync(p, 'utf-8').split('\n')) {
      if (!l) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      const u = m?.message?.usage;
      if (u) {
        tok.out += u.output_tokens ?? 0;
        tok.input += u.input_tokens ?? 0;
        tok.cacheRead += u.cache_read_input_tokens ?? 0;
        tok.cacheWrite += u.cache_creation_input_tokens ?? 0;
      }
      const cc = m?.message?.content;
      if (!Array.isArray(cc)) continue;
      if (cc.some((c) => c?.type === 'tool_use')) tok.msgs++;
      for (const c of cc) {
        if (c?.type !== 'tool_use') continue;
        let name = c.name;
        if (name === 'Bash' || name === 'PowerShell') {
          const cmd = String(c.input?.command ?? '');
          name = /pgraph(\.mjs)?\s/.test(cmd) ? 'pgraph' : /(\bgrep|\brg\b|Select-String)/.test(cmd) ? 'Bash:grep' : 'Bash:other';
        }
        counts[name] = (counts[name] ?? 0) + 1;
      }
    }
    const k = `${r.arm}`;
    if (!per.has(k)) per.set(k, { runs: 0, counts: {}, listCounts: {}, listRuns: 0, tok: { out: 0, cacheRead: 0, cacheWrite: 0, input: 0, msgs: 0 } });
    const slot = per.get(k);
    slot.runs++;
    for (const [n, v] of Object.entries(counts)) slot.counts[n] = (slot.counts[n] ?? 0) + v;
    if (LIST(r)) {
      slot.listRuns++;
      for (const [n, v] of Object.entries(counts)) slot.listCounts[n] = (slot.listCounts[n] ?? 0) + v;
      for (const key of Object.keys(tok)) slot.tok[key] += tok[key];
    }
  }
  // Both averages, because they are not the same number and the difference is
  // large: the transitive question alone runs about ten times the tools of a
  // list question, so an all-nine average says more about it than about the
  // other eight. Quote the list row when comparing "who calls X".
  for (const [label, key, n] of [['the list questions', 'listCounts', 'listRuns'], ['every question', 'counts', 'runs']]) {
    console.log(`\n== tools used per question, ${label} ==\n`);
    for (const [arm, slot] of per) {
      const parts = Object.entries(slot[key]).sort((a, b) => b[1] - a[1])
        .map(([nm, v]) => `${nm} ${(v / Math.max(slot[n], 1)).toFixed(1)}`);
      const total = Object.values(slot[key]).reduce((a, b) => a + b, 0) / Math.max(slot[n], 1);
      console.log(`${arm.padEnd(6)} (${slot[n]} runs)  total ${total.toFixed(1)}  |  ${parts.join('  ')}`);
    }
  }

  console.log('\n== tokens per question, the list questions ==\n');
  const head = ['arm', 'runs', 'output', 'cache read', 'cache write', 'fresh input', 'tool messages'];
  const table = [...per].map(([arm, s2]) => {
    const n = Math.max(s2.listRuns, 1);
    const k = (v) => (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v)));
    return [arm, String(s2.listRuns), k(s2.tok.out / n), k(s2.tok.cacheRead / n),
      k(s2.tok.cacheWrite / n), k(s2.tok.input / n), (s2.tok.msgs / n).toFixed(1)];
  });
  const w = head.map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  table.forEach((t) => console.log(line(t)));
  console.log('\nAt these context sizes the bill is mostly cache reads, so "output" is the wrong');
  console.log('column to read for cost. An extra step is paid for by re-reading, not by writing.');
}

if (flag('score')) { doScore(); noise(); followTheCalls(); toolUse(); byLanguage(); boxes(); }
else if (phase === 'base' || phase === 'graph') { await runArm(String(phase)); }
else {
  console.log('use --phase base | --phase graph | --score');
  process.exit(2);
}
