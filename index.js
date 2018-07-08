'use strict';

const _supportedCdns = ['qiniu', 'txcos'];
const fs = require('fs');

class WebpackBundleUploaderPlugin{

    constructor( options ){
        this.options = options;
    }

    initUploader( cdnObject ){
        
        switch ( cdnObject.type ){
            case 'qiniu':
                if ( !cdnObject.secretKey || !cdnObject.accessKey ){
                    return false;
                }
                const Qiniu = require('./libs/qiniu-node');         
                
                this.cdn = new Qiniu( cdnObject.accessKey, cdnObject.secretKey, cdnObject.host );

                return true;
            case 'txcos':
                if ( !cdnObject.secretKey || !cdnObject.accessKey ){
                    return false;
                }

                const COS = require('cos-nodejs-sdk-v5');
                this.cdn = new COS({
                    SecretId:cdnObject.accessKey,
                    SecretKey:cdnObject.secretKey
                });

                return true;
            case 'aliyun':
            case 'ftp':
        }

        return false;

    }

    async upload( data , name){

        switch ( this.cdn.constructor.name ){
            case 'Qiniu':
                try{
                    return await this.cdn.uploadByData( this.options.cdn.bucket, data, { fileName:name } );
                }catch(e){
                    return e;
                }
            case 'COS':
                const uploadAction = () =>{
                    return new Promise( (resolve, reject) =>{
                        const _data = new Buffer( data );
    
                        this.cdn.putObject({
                            Bucket:this.options.cdn.bucket,
                            Region:this.options.cdn.host,
                            Key:name,
                            Body:_data.toString(),
                            ContentLength:_data.length
                        }, (err, data)=>{
                            if ( err ){
                                reject();
                                return;
                            }
                            resolve(data);
                        });
                    });
                }

                try {
                    return await uploadAction();
                }catch(e){
                    return e;
                }
        }

        return false;
    }
    
    async deletePreviousResources( log ){

        this.initUploader( log.cdn );

        if ( !Array.isArray( log.files ) || log.files.length <= 0 ){
            return {
                error:'原记录中文件列表有误或为空, 请检查导出目录中的wp.bundle.json文件'
            };
        }

        switch ( log.cdn.type ){
            case 'qiniu':
                const resources = log.files.map( file =>{
                    return {
                        bucket:log.cdn.bucket,
                        fileName:file.fileName
                    };
                });

                try {
                    return await this.cdn.batchAction( resources, 'delete' );
                }catch( e ){
                    return e;
                }
            case 'txcos':
                const params = {
                    Bucket:log.cdn.bucket,
                    Region:log.cdn.host,
                    Objects:log.files.map( file =>{
                        return {
                            Key:file.fileName
                        };
                    })
                };

                const deleteAction = () =>{
                    return new Promise( (resolve,reject)=>{
                        this.cdn.deleteMultipleObject( params , (err, data)=>{
                            if ( err ){
                                reject(err);
                                return;
                            }
    
                            resolve(log.files.length);
                        });
                    });
                }

                try {
                    return await deleteAction();
                }catch( e ){
                    return e;
                }
        }

        return false;
    }

    async handleEmitted(compilation , callback = null){

        const outputOptions = compilation.outputOptions || compilation.options.output;
        const { path } = outputOptions;
        const previousPath = `${path}\\wp.previous.json`;
        const _test = this.options.test || /\.(js|css)$/;
            
        if ( !(_test instanceof RegExp) ){
            console.log('\x1b[31m', '无效test正则参数' );
            if ( callback !== null ) callback();
            return;
        }

        if ( !this.options.cdn || !this.options.cdn.type || !_supportedCdns.includes( this.options.cdn.type ) ){
            console.log('\x1b[31m', '暂不支持所选CDN');
            if ( callback !== null ) callback();
            return;
        }

        if ( this.options.deletePrevious ){
            console.log( 'deletePrevious状态为开启, 正在删除CDN资源...' );
            try {

                if ( !fs.existsSync(previousPath) ){
                    throw ( '上次上传记录不存在' );
                }

                const previousLog = fs.readFileSync( previousPath, 'utf8' );

                if ( previousLog && previousLog.Error ){
                    throw ( previousLog.Error );   
                }

                const _log = JSON.parse( previousLog );

                const cdnDeleteResponse = await this.deletePreviousResources( _log );

                if ( cdnDeleteResponse && typeof cdnDeleteResponse.error !== 'undefined' ){
                    throw( cdnDeleteResponse.error );
                }

                if ( cdnDeleteResponse === false ){
                    throw ('上一次CDN上传记录有误, 找不到可支持CDN, 请检查导出目录中的wp.bundle.json文件');
                }

                console.log( '\x1b[32m', `成功删除${cdnDeleteResponse}个上次上传bundle文件` );

                fs.unlinkSync( previousPath );
            }catch( e ){
                console.log('\x1b[31m', `跳过删除上一次上传文件, 因为:${e}`);
            }
        }

        const uploader = this.initUploader( this.options.cdn );

        if( !uploader ){
            console.log('\x1b[31m', '加载CDN对象失败, 请检查CDN参数是否完整');
            if ( callback !== null ) callback();
            return;
        }

        let previousOutput = {
            cdn:this.options.cdn,
            files:[]
        }
        let uploaderError = false;

        console.log('\x1b[32m', '开始上传Bundle文件至CDN...');

        for ( let asset in compilation.assets ){

            const { existsAt, _value, _name } = compilation.assets[asset];
            if ( !_test.test( existsAt ) ){
                continue;
            }

            let response, fileName;
        
            try {
                //非js文件不会直接包括文件内容, 需要使用fs提取内容并手动提取文件名
                if ( typeof _name === 'undefined' ){
                    fileName = existsAt.replace(`${path}\\`, '').replace(/\\/g, '/');
                    const fileContent = fs.readFileSync( existsAt,'utf8');
                    response = await this.upload( fileContent, fileName );
                }else{
                    fileName = _name;
                    response = await this.upload( _value, _name );
                }

                if ( this.options.deleteOutput ){
                    fs.unlinkSync( `${path}\\${fileName}` );   
                }

                previousOutput.files.push( {fileName} );

                console.log( `文件${fileName}上传完成`);
            }catch( e ){
                uploaderError = true;
                console.log('\x1b[31m',`读取文件${fileName}出错: ${e}, 上传中断请尝试重新打包`);
                break;
            }

            //一个文件出错则停止所有上传
            if ( typeof response.error !== 'undefined' ){
                uploaderError = true;
                console.log('\x1b[31m', `CDN上传出错 : ${response.error}, 上传中断请尝试重新打包`);
                break;
            }
            
            
        }

        //保存上传记录, 用于下一次删除
        if ( previousOutput.files.length > 0 ){
            fs.writeFileSync( previousPath, JSON.stringify( previousOutput ));
        }

        if ( !uploaderError ){

            console.log('\x1b[0m', '所有文件已上传至CDN');

            if ( this.options.deleteOutput ){
                console.log('deleteOutput状态为启用, 所以所有bundle文件已删除');
            }
        }else{
            console.log('\x1b[0m', '上传中断');
        }

        if ( callback !== null ) callback();

    }

    apply(compiler){
        
        //webpack版本兼容
        if ( compiler.hooks ){ //webpack 4
            compiler.hooks.afterEmit.tapAsync(
                'BundleUploaderPlugin',
                this.handleEmitted.bind(this)
            )
        }else{ //webpack 3
            compiler.plugin('after-emit', this.handleEmitted.bind(this));
        }

    }

}

module.exports = WebpackBundleUploaderPlugin;