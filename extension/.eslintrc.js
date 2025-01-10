module.exports = {
	"env": {
		"browser": true,
		"es2021": true,
		"webextensions": true,
		"node": true
	},
	"extends": [
		"eslint:recommended",
		"plugin:jsdoc/recommended"
	],
	"plugins": [
		"jsdoc"
	],
	"parserOptions": {
		"ecmaVersion": 2021,
		"sourceType": "module"
	},
	"ignorePatterns": ["fs/mnt/**/*"],
	"rules": {
		"jsdoc/require-jsdoc": ["warn", {
			"require": {
				"FunctionDeclaration": true,
				"MethodDefinition": true,
				"ClassDeclaration": true
			}
		}],
		"jsdoc/require-param-type": "warn",
		"jsdoc/require-returns-type": "warn",
		"no-unused-vars": "off",
		"no-useless-escape": "off",
		"no-control-regex": "off",
		"jsdoc/require-property-description": "off"
	},
	"settings": {
		"jsdoc": {
			"mode": "typescript"
		}
	}
}