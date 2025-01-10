# TabFS TODO List

## Core Functionality Enhancements

### File System Features
- [ ] Add support for arbitrary files in subtrees (`.git`, Mac extended attrs, editor temp files)
- [ ] Improve persistence handling
- [ ] Address tab lifecycle/disposability differences from regular filesystem
- [ ] Investigate why GUI programs (like Preview) struggle with filesystem access
- [ ] Add more synthetic files for:
  - [ ] DOM node viewing
  - [ ] Page HTML snapshots
  - [ ] Live object inspection
  - [ ] Runtime code analysis
- [ ] Make more files writable

### Performance Optimization
- [ ] Optimize browser roundtrips
- [ ] Implement reference counting
- [ ] Cache attachment status to resources
- [ ] Profile and identify performance bottlenecks
- [ ] Address application hanging issues during slow requests
- [ ] Investigate FUSE-specific performance patterns

### Multi-threading
- [ ] Evaluate performance benefits of multi-threading
- [ ] Implement request interleaving for async operations
- [ ] Handle concurrent filesystem operations
- [ ] Optimize screenshot and other slow operations

## Browser Integration

### Browser Management Features
- [ ] Implement comprehensive window management
- [ ] Add tab movement capabilities
- [ ] Create 'merge all windows' functionality
- [ ] Develop history management system
- [ ] Improve tab organization features

## Development Infrastructure

### Type Safety
- [ ] Evaluate TypeScript integration options
- [ ] Consider lightweight type checking alternatives
- [ ] Implement dynamic type checking at filesystem operation boundaries
- [ ] Balance type safety with minimal build requirements

### Tools Development
- [ ] Build additional GUI tools
- [ ] Develop CLI utilities
- [ ] Create debugging tools
- [ ] Add monitoring capabilities
- [ ] Implement diagnostic features

## Documentation & Testing

### Documentation
- [ ] Improve installation guides
- [ ] Create detailed API documentation
- [ ] Add more usage examples
- [ ] Document common issues and solutions
- [ ] Create contribution guidelines

### Testing
- [ ] Add unit tests
- [ ] Implement integration tests
- [ ] Create performance benchmarks
- [ ] Add cross-browser testing
- [ ] Develop filesystem operation tests

## Community & Maintenance

### Community Support
- [ ] Track and list community contributions
- [ ] Create issue templates
- [ ] Implement feature request process
- [ ] Maintain contributor acknowledgments

### Project Management
- [ ] Prioritize feature requests
- [ ] Maintain changelog
- [ ] Version management
- [ ] Release planning
- [ ] Security review process

## Known Issues to Address
- [ ] Fix GUI program compatibility issues
- [ ] Address filesystem hanging during slow operations
- [ ] Resolve tab persistence quirks
- [ ] Improve error handling
- [ ] Handle edge cases in filesystem operations

---

Note: This is a living document. Feel free to add, modify, or reprioritize items as needed. Contributions and suggestions are welcome! 