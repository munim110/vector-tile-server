import { createServer } from 'http';
import { parse } from 'url';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';




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

const OBJCACHE = {}
const PROMISES = {}

/* request counter variable */

var SERVED_TILES = 0
const START_TIME = Date.now();

/* dashboard html template */

const dashboard_template = readFileSync('./src/dashboard.html','utf8')

/*
    @removed cached object following LRU cache replacement policy 
*/
function cache_control(){


    let obj_keys = Object.keys(OBJCACHE);

    if ( obj_keys.length > CONFIG.ncache - 1 ){

        // find objcache key with minimum accesstime
        let remove_key = obj_keys[0];
        
        let min_accessrank = OBJCACHE[obj_keys[0]].accessrank;
        
        for(let i=0;i<obj_keys.length; i++){
            
            let ikey = obj_keys[i];

            if (OBJCACHE[ikey].accessrank < min_accessrank ){
                remove_key = ikey;
            }

        }

        console.log('Cache limit exceeds removing: ', remove_key)
        delete(OBJCACHE[remove_key])

    }
    
    return 0;

}

/*
    @returns a promise containing sliced tile for ZXY index
*/ 
function get_tile(file_name,zxy){

    let z=zxy.z,
        x=zxy.x,
        y=zxy.y;

    let call_time = Date.now();
    SERVED_TILES++
    
    if ( OBJCACHE[file_name] == undefined && PROMISES[file_name]==undefined ){ 
        // check if cache need to be cleared before reading a new file 
        // cache_control();
        console.log(`R;${call_time}`,z,x,y,file_name)
        PROMISES[file_name] = read_file_async(file_name)
    }
    else{
        console.log(`C;${call_time}`,z,x,y,file_name);
    }
    
    return PROMISES[file_name].then(()=>{
        OBJCACHE[file_name].accessrank = Date.now()
        return OBJCACHE[file_name].getTile(z,x,y)
    });
    

}


async function read_file_async(file_name){
    
    let file_full_path = `${CONFIG.source_dir}/${file_name}`

    // let data = readFileSync(file_full_path,'utf8');
    let data = await readFile(file_full_path,'utf8')
    OBJCACHE[file_name] = geojsonvt(JSON.parse(data),CONFIG.tileconfig);
    OBJCACHE[file_name].accessrank = Date.now()

    
}


/*
    @parses filename, z, x, y values from url
*/ 
function get_url_parts(req){


    let parts = parse(req.url,true).pathname.split('/')
    
    let route = parts[1],
        file = parts[2],
        z = parseInt(parts[3]),
        x = parseInt(parts[4]),
        y = parseInt(parts[5]);

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

function rj200(res,data,type){
    res.writeHead(200, {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*'
    })
    res.write(JSON.stringify(data))
    res.end()
}

/*
    @returns binary encoded 200 OK response 
*/
function rb200(res,data,type){
    res.writeHead(200, {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*'
    })
    let buffer = Buffer.from(vtpbf.fromGeojsonVt({'geojsonLayer':data}))
    res.write(buffer, 'binary')
    res.end(null, 'binary')
    // buffer = null
    
}
/*
    @rturns 404 Not Found
*/
function r404(res,message=''){
    res.writeHead(404,{
        'Message':message
    })
    res.end()
}

/*
    @rturns 204 No Content
*/
function r204(res){
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
    return res.end()
}


async function dashboard_response(res){

    let cached_obj_keys = Object.keys(OBJCACHE);
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
                <br>Last access time: ${OBJCACHE[cached_obj_keys[i]].accessrank}
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



function tile_response(tile_data,res){
    
    if(tile_data != null && tile_data !=undefined) {
        if(CONFIG.tile_format=='protobuf'){
            rb200(res,tile_data,'application/protobuf')
        }
        else if(CONFIG.tile_format=='geojson'){
            rj200(res,tile_data,'application/geo+json')
        }
    }
    else if(tile_data==null) { 
        r204(res);
    }else{
        r404(res);
    }

}

/*
    @handles http requests
*/


async function handle_request(req,res){

    let params = get_url_parts(req)
    
    if (params == null){
        rj200(res,"{'message':'invalid uri'}",'application/json')

    }

    else if (params.route=='tile'){
        
        get_tile(params.tile.file, params.tile.zxy).then((tile_data)=>{
            tile_response(tile_data,res)
        })
        
    }
    else if(params.route=='dash'){

        dashboard_response(res).then(()=>{
            console.log('D;',Date.now())
        });
        
    }else{
        r204(res);
        
    }
    
}

function get_config_protocol(){

    let isTCP = CONFIG.protocol.toUpperCase() == 'TCP' && 
                CONFIG.port != undefined;
    
    if (isTCP===true) {return 'TCP';}

    let isSOCKET = CONFIG.protocol.toUpperCase() == 'SOCKET' && 
                   CONFIG.unix_socket != undefined;
    
    if (isSOCKET === true) {return 'SOCKET';}
}

function main(){

    let protocol = get_config_protocol(); 

    if( protocol ==='TCP' ){
        createServer(handle_request).listen(CONFIG.port)
        console.log(`listening to http://127.0.0.1:${CONFIG.port}`)
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
 docs:
 http://richorama.github.io/2019/02/05/roll-your-own-vector-tile-service/ 
 https://stackoverflow.com/questions/33547088/how-to-display-vector-tiles-generated-by-geojson-vt-in-leaflet

#Todo:
 - Add MongoDB backend with file as fallback
 - Create a dashboard for cache monitoring (done)
 - Add multi process support
 - Add support for loading composite tiles composite layer support
 - read file as stream to reduce memory usage (priority)

 #Notes:
    #) file read is blocking by nature
       if fileis there and cache is not 
       initialized then will the read file multiple time

        ** possible solutions:
            do a prerequest to initialize the cache
            then the get_tile call can be non blocking

    #) readFileSync causes high memory usage when reading
       large files. It drops afterwards. 
       **  Possible solutions:
             - Database can be used to check if this can be solved
             - read json file in streaming way


    Request Pattern:
    - /tile/filename/z/x/y                                |  loading single file
    - /tile/f_one[layer_name]+f_two[layer_name]/z/x/y.mvt | loading multiple file
    - /dash/                                              |  dashboard
     

** best implementation yet
** implement worker
*/