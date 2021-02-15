//
//  main.swift
//  TabFSServer
//
//  Created by Omar Rizwan on 2/8/21.
//

import Foundation
import Network
import os.log

class TabFSServer {

    var fs: Process!
    var fsInput: FileHandle!
    var fsOutput: FileHandle!
    func startFs() {
        let fileURL = URL(fileURLWithPath: #filePath)
        let repoURL = fileURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        
        fs = Process()
        fs.executableURL = repoURL.appendingPathComponent("fs").appendingPathComponent("tabfs")
        fs.currentDirectoryURL = fs.executableURL?.deletingLastPathComponent()
        
        fs.arguments = []
        
        let inputPipe = Pipe(), outputPipe = Pipe()
        fs.standardInput = inputPipe
        fs.standardOutput = outputPipe
        
        fsInput = inputPipe.fileHandleForWriting
        fsOutput = outputPipe.fileHandleForReading
        
        try! fs.run()
    }

    var ws: NWListener!
    func startWs() {
        // TODO: randomly generate port and report back to caller?
        let port = NWEndpoint.Port(rawValue: 9991)!
        
        let parameters = NWParameters(tls: nil)
        parameters.allowLocalEndpointReuse = true
        parameters.includePeerToPeer = true
        // for security ? so people outside your computer can't hijack TabFS at least
        parameters.requiredInterfaceType = .loopback
        
        let opts = NWProtocolWebSocket.Options()
        opts.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(opts, at: 0)
        
        ws = try! NWListener(using: parameters, on: port)
        ws.start(queue: .main)
    }

    init() {
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
                        os_log(.default, "req %{public}@ error: %{public}@", String(data: req, encoding: .utf8)!, err!.debugDescription as CVarArg)
                        // FIXME: ERROR
                    }
                }))
            }
            
            func read() {
                conn.receiveMessage { (resp, context, isComplete, err) in
                    guard let resp = resp else {
                        if let err = err {
                            os_log(.default, "resp error: %{public}@", err.debugDescription as CVarArg)
                        }
                        return
                    }
                    
                    // Send the response back to tabfs.c.
                    self.fsInput.write(withUnsafeBytes(of: UInt32(resp.count)) { Data($0) })
                    self.fsInput.write(resp)
                    read()
                }
            }
            read()
        }

        DispatchQueue.global(qos: .default).async {
            while true {
                // Blocking read from the tabfs process.
                let length = self.fsOutput.readData(ofLength: 4).withUnsafeBytes { $0.load(as: UInt32.self) }
                let req = self.fsOutput.readData(ofLength: Int(length))
                
                if let handleRequest = handleRequest {
                    // Send the request over the WebSocket connection to background.js in browser.
                    handleRequest(req)
                } else {
                    // FIXME: ERROR
                }
            }
        }
        
        print("OK")
    }
}

let server = TabFSServer()

dispatchMain()
