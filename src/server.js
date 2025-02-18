import { createServer } from 'http';
import * as url from 'url';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFile } from 'fs/promises';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { LRUCache } from 'lru-cache';
import path from 'path';
import { fileURLToPath } from 'url';

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
# Options:
  --config : json file containing configuration options          
*/

const argv = yargs(hideBin(process.argv)).argv

if ( argv.config == undefined  ){
    console.log("provide a config file using --config")
    process.exit(1)
}

const CONFIG = JSON.parse(readFileSync(argv.config))

/*
    geojson-vt object cache  
*/

const OBJECT_CACHE = new LRUCache({
    max: CONFIG.ncache, // Maximum number of items in the cache
    ttl: 1000 * 60 * 60, // Optional: Time-to-live in milliseconds (e.g., 1 hour)
    updateAgeOnGet: true, // Update the item's age when accessed
});
const PROMISES = {}

/* request counter variable */

var SERVED_TILES = 0
const START_TIME = Date.now();

/* dashboard html template */

const dashboard_template = readFileSync('./src/dashboard.html','utf8')


/*
    @returns a promise containing sliced tile for ZXY index
*/ 
async function get_tile(file_name,zxy){

    let z=zxy.z,
        x=zxy.x,
        y=zxy.y;

    let call_time = Date.now();
    
    SERVED_TILES++;
    
    if (!OBJECT_CACHE.has(file_name) && PROMISES[file_name] == undefined) { 
        PROMISES[file_name] = read_file_async(file_name);
        console.log(`R;${call_time}`,z,x,y,file_name);
    }
    else{
        console.log(`C;${call_time}`,z,x,y,file_name);
    }
    
    return PROMISES[file_name].then(()=>{
        // OBJECT_CACHE[file_name].accessrank = Date.now()
        return OBJECT_CACHE.get(file_name).getTile(z, x, y);
    }).catch((err)=>{
        console.log(err)
    });
    

}


async function read_file_async(file_name) {
    try {
        let file_full_path = `${CONFIG.source_dir}/${file_name}`;
        let data = await readFile(file_full_path, 'utf8');
        OBJECT_CACHE.set(file_name, geojsonvt(JSON.parse(data), CONFIG.tileconfig));
        console.log(`Cache SET: ${file_name}`);
    } catch (err) {
        console.error(`Error reading file ${file_name}:`, err);
        delete PROMISES[file_name]; // Allow retry if file read fails
        throw err; // Ensure error propagates
    }
}



/*
    @parses filename, z, x, y values from url
*/ 
function get_url_parts(req){
    let _url = url.parse(req.url,true);
    let parts = _url.pathname.split('/');
    let file = _url.query['file'];
    let route = parts[1];

    if (route == 'files') {
        return { 'route': route };
    }

    let z = parseInt(parts[2]),
        x = parseInt(parts[3]),
        y = parseInt(parts[4]);

    
    if (route !=undefined || route!=''){
        if(route=='tile'){
            if( file != undefined && z!=undefined && x!=undefined && y!=undefined ){
                return {
                    'route':route, 
                    tile:{
                        'file':file, 
                        'zxy':{'z':z, 'x':x, 'y':y}
                    }
                }
            }else{
                return null;
            }
        }else{
            return {'route':route}
        }
    }else{
        return null;
    }
    


}

/*
    @returns plain text 200 OK response 
*/

function response_json(res, data){
    res.writeHead(200, {
        'Content-Type': 'application/geo+json',
        'Access-Control-Allow-Origin': '*'
    })
    res.write(JSON.stringify(data))
    res.end()
}

/*
    @returns binary encoded 200 OK response 
*/
function response_protobuf(res, data){
    res.writeHead(200, {
        'Content-Type': 'application/protobuf',
        'Access-Control-Allow-Origin': '*'
    })
    let buffer = Buffer.from(vtpbf.fromGeojsonVt({'geojsonLayer':data}))
    res.write(buffer, 'binary')
    res.end(null, 'binary')
    // buffer = null
    
}

/*
    @returns 404 Not Found
*/
function response_404(res,message=''){
    res.writeHead(404, {
        'Access-Control-Allow-Origin': '*', 
        'Message':message
    })
    res.end()
}

/*
    @returns 204 No Content
*/
function response_204(res){
    res.writeHead(204, { 
        'Access-Control-Allow-Origin': '*'
    })
    return res.end()
}

/*
    @returns dashboard response
*/
async function dashboard_response(res){

    let cached_obj_keys = Array.from(OBJECT_CACHE.keys());
    let memory_usage = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(2).toString()
    let cached_obj_count = cached_obj_keys.length.toString();
    let tile_conf_str = JSON.stringify(CONFIG.tileconfig,null,4);
    let uptime_hr = ( (Date.now() - START_TIME)/1000/60/60).toFixed(2);
    let cached_obj_list = '';

    for (let i=0; i< cached_obj_keys.length; i++){
        cached_obj_list+=`
        <tr>
            <td>${i+1}</td>
            <td>
                <a><span class='bull'>&#x25A3;</span> ${cached_obj_keys[i]}</a>
                <br>Last access time: ${new Date().toLocaleString()}
            </td>
        </tr>
        `;
    }
    
    let html_str = dashboard_template.replace("{{tile_config}}",tile_conf_str)
        .replace("{{cached_obj_count}}",cached_obj_count)
        .replace("{{memory_in_mb}}",memory_usage)
        .replace("{{cached_obj_list}}",cached_obj_list)
        .replace("{{served_tile_request}}",SERVED_TILES.toString())
        .replace("{{uptime}}",uptime_hr);


        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
        })
        res.end(html_str)
}


/*
    @returns json/protobuf tiles
*/
function tile_response(tile_data,res){
    
    if(tile_data != null && tile_data !=undefined) {
        if(CONFIG.tile_format=='protobuf'){
            response_protobuf(res,tile_data)
        }
        else if(CONFIG.tile_format=='geojson'){
            response_json(res,tile_data)
        }
    }
    else if(tile_data==null) { 
        response_204(res);
    }else{
        response_404(res);
    }

}

/*
    @handles http requests
*/
function handle_request(req, res) {
    let params = get_url_parts(req)

    if (params == null) {
        response_json(res, "{'message':'invalid uri'}", 'application/json')
    }

    else if (params.route == 'tile') {
        // Check if file exists first
        if (!existsSync(params.tile.file)) {
            response_404(res);
            return;
        }
        
        get_tile(params.tile.zxy, params.tile.file).then((tile_data) => {
            tile_response(tile_data, res)
        })
    }

    // Add new files route handler
    else if (params.route == 'files') {
        try {
            const files = readdirSync(CONFIG.source_dir)
                .filter(file => file.endsWith('.geojson'))
                .map(file => ({
                    name: file,
                    size: statSync(path.join(CONFIG.source_dir, file)).size
                }));
            response_json(res, files);
        } catch (err) {
            console.error('Error reading directory:', err);
            response_json(res, []);
        }
    }

    else if (params.route == 'dashboard') {
        dashboard_response(res).then(() => {
            console.log('D;', Date.now())
        });
    } else {
        response_404(res);
    }
}

/* 
    @parses configuration of server
*/
function get_config_protocol(){

    let isTCP = CONFIG.protocol.toUpperCase() == 'TCP' && 
                CONFIG.port != undefined;

    if (isTCP===true) {return 'TCP';}

    let isSOCKET = CONFIG.protocol.toUpperCase() == 'SOCKET' && 
                   CONFIG.unix_socket != undefined;

    if (isSOCKET === true) {return 'SOCKET';}
}

/* 
    @entry point of the server
*/
function main(){

    let protocol = get_config_protocol(); 

    if( protocol ==='TCP' ){
        createServer(handle_request).listen(CONFIG.port)
        console.log(`* listening to http://127.0.0.1:${CONFIG.port}`)
        console.log(`* visit dashboard using the link http://127.0.0.1:${CONFIG.port}/dashboard`)
    }
    else if( protocol === 'SOCKET' ){
        createServer(handle_request).listen(CONFIG.unix_socket)
        console.log(`listening to ${CONFIG.unix_socket}`)
    }
}

/* 
    @start the tile server 
*/
main();

/*
 Documentation:
 - http://richorama.github.io/2019/02/05/roll-your-own-vector-tile-service/ 
 - https://stackoverflow.com/questions/33547088/how-to-display-vector-tiles-generated-by-geojson-vt-in-leaflet

 Todo:
 - Add MongoDB backend with file as fallback
 - Create a dashboard for cache monitoring (done)
 - Add multi process support
 - Add support for loading composite tiles composite layer support
 - Read file as stream to reduce memory usage (priority)
 - Change the request pattern like this /tile/z/x/y?file=<file1_name>&file=<file2_name>

 Request Pattern:
 - /tile/filename/z/x/y                                |  loading single file
 - /tile/f_one[layer_name]+f_two[layer_name]/z/x/y.mvt |  loading multiple file
 - /dash/                                              |  dashboard
*/