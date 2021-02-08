//
//  TabFSService.swift
//  TabFSService
//
//  Created by Omar Rizwan on 2/7/21.
//

import Foundation
import Network
import os.log

class TabFSService: NSObject, TabFSServiceProtocol {
    var fs: Process!
    var fsInput: FileHandle!
    var fsOutput: FileHandle!
    func startFs() {
        fs = Process()
        fs.executableURL = URL(fileURLWithPath: "/Users/osnr/Code/tabfs/fs/tabfs")
        fs.currentDirectoryURL = fs.executableURL?.deletingLastPathComponent()
        
        fs.arguments = []
        
        let inputPipe = Pipe(), outputPipe = Pipe()
        fs.standardInput = inputPipe
        fs.standardOutput = outputPipe
        
        fsInput = inputPipe.fileHandleForWriting
        fsOutput = outputPipe.fileHandleForReading
        
        os_log(.default, "TabFSmsg tfs service: willrun")
        try! fs.run()
        os_log(.default, "TabFSmsg tfs service: ran")
    }
    
    var ws: NWListener!
    func startWs() {
        let port = NWEndpoint.Port(rawValue: 9991)!
        let parameters = NWParameters(tls: nil)
        parameters.allowLocalEndpointReuse = true
        parameters.includePeerToPeer = true
        let opts = NWProtocolWebSocket.Options()
        opts.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(opts, at: 0)
        
        ws = try! NWListener(using: parameters, on: port)
        ws.start(queue: .main)
    }
    
    override init() {
        super.init()
        
        startFs()
        startWs()
        
        var handleRequest: ((_ req: Data) -> Void)?
        ws.newConnectionHandler = { conn in
            conn.start(queue: .main)
            
            handleRequest = { req in
                let metaData = NWProtocolWebSocket.Metadata(opcode: .text)
                let context = NWConnection.ContentContext(identifier: "context", metadata: [metaData])
                conn.send(content: req, contentContext: context, completion: .contentProcessed({ err in
                    if err != nil {
                        os_log(.default, "%{public}@ error: %{public}@", String(data: req, encoding: .utf8) as! CVarArg, err!.debugDescription as CVarArg)
                        // FIXME: ERROR
                    }
                }))
            }
            
            func read() {
                conn.receiveMessage { (resp, context, isComplete, err) in
                    guard let resp = resp else {
                        // FIXME err
                        os_log(.default, "resp error: %{public}@", err!.debugDescription as CVarArg)
                        return
                    }
                    
                    os_log(.default, "resp %{public}@", String(data: resp, encoding: .utf8) as! CVarArg)
                    self.fsInput.write(withUnsafeBytes(of: UInt32(resp.count)) { Data($0) })
                    self.fsInput.write(resp)
                    read()
                }
            }
            read()
        }
        
        // split new thread
        DispatchQueue.global(qos: .default).async {
            while true {
                // read from them
                let length = self.fsOutput.readData(ofLength: 4).withUnsafeBytes { $0.load(as: UInt32.self) }
                os_log(.default, "TabFSmsg tfs service: read %{public}d", length)
                let req = self.fsOutput.readData(ofLength: Int(length))
                
                // send to other side of WEBSOCKET
                if let handleRequest = handleRequest {
                    handleRequest(req)
                } else {
                    // FIXME: ERROR
                }
            }
        }
        // FIXME: disable auto termination
    }
    
    func upperCaseString(_ string: String, withReply reply: @escaping (String) -> Void) {
        let response = string.uppercased()
        reply(response)
    }
//
//    func response(_ resp: Data) {
//        fsInput.write(withUnsafeBytes(of: UInt32(resp.count)) { Data($0) })
//        fsInput.write(resp)
//    }
}

class TabFSServiceDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection newConnection: NSXPCConnection) -> Bool {
        os_log(.default, "TabFSmsg tfs service: starting delegate")
        
        let exportedObject = TabFSService()
        newConnection.exportedInterface = NSXPCInterface(with: TabFSServiceProtocol.self)
        newConnection.exportedObject = exportedObject
        
        newConnection.resume()
        return true
    }
}
