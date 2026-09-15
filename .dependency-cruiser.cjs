const generatedConfig = process.env.ARCHITECTURE_CONFIG

if (!generatedConfig) {
  throw new Error('ARCHITECTURE_CONFIG must name the generated architecture config JSON')
}

module.exports = require(generatedConfig)
